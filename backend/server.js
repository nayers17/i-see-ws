// backend/server.js

require('dotenv').config();
const express = require('express');
const passport = require('passport');
const GitHubStrategy = require('passport-github').Strategy;
const session = require('express-session');
const path = require('path');
const { Octokit } = require("@octokit/rest");
const flash = require('connect-flash');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const morgan = require('morgan');
const http = require('http');
const { Server } = require('socket.io');
const SequelizeStore = require('connect-session-sequelize')(session.Store);
const axios = require('axios');
const NodeCache = require('node-cache');
const crypto = require('crypto');

// **Import Sequelize from db.js**
const sequelize = require('./db');

// **Import Job Model**
const Job = require('./models/job');

// **Import Fine-Tuning Queue Initializer**
const initializeFineTuningQueue = require('./queues/fineTuningQueue');

// **Initialize Express App**
const app = express();

// **Generate Nonce and Configure Helmet**
app.use((req, res, next) => {
    res.locals.nonce = crypto.randomBytes(16).toString('base64');  // Generate a unique nonce
    console.log(`Generated nonce for request: ${res.locals.nonce}`); // Logging the nonce
    next();
});

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            "default-src": ["'self'"],
            "style-src": [
                "'self'",
                "https://cdn.jsdelivr.net",
                "https://cdnjs.cloudflare.com",
                (req, res) => `'nonce-${res.locals.nonce}'` // Apply nonce to inline styles
            ],
            "script-src": [
                "'self'",
                (req, res) => `'nonce-${res.locals.nonce}'`, // Apply nonce to inline scripts
                "https://cdn.jsdelivr.net",
                "https://cdnjs.cloudflare.com"
            ],
            "img-src": ["'self'", "data:"],
            "font-src": ["'self'", "https://cdnjs.cloudflare.com"],
            "connect-src": [
                "'self'",
                "ws://localhost:5000", // Allow WebSocket connections
                "http://localhost:5000" // Allow HTTP polling
            ],
            // Add other directives as needed
        }
    }
}));

// **Logging Middleware**
app.use(morgan('combined'));

// **Rate Limiting Middleware**
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

// **EJS Configuration**
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../frontend/views'));

// **Parse URL-encoded bodies and JSON**
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// **Serve Static Files from the "public" Directory**
app.use(express.static(path.join(__dirname, '../frontend/public')));

// **Initialize Session Store with Sequelize**
const sessionStore = new SequelizeStore({
    db: sequelize,
});

// **Session Configuration**
app.use(session({
    secret: process.env.SESSION_SECRET, // Ensure this is set in your environment variables
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }  // Set secure: true if using HTTPS
}));

// **Synchronize the Session Store**
sessionStore.sync();

// **Flash Messages Middleware**
app.use(flash());

// **Make Flash Messages and User Data Available in All Templates**
app.use((req, res, next) => {
    res.locals.success_msg = req.flash('success_msg');
    res.locals.error_msg = req.flash('error_msg');
    res.locals.error = req.flash('error');
    res.locals.username = req.user ? req.user.username : null;
    res.locals.avatar_url = req.user ? req.user.avatar_url : null;
    res.locals.hf_token = req.session.hf_token || null; // Make hf_token available in templates
    res.locals.userId = req.user ? req.user.id : null; // User ID for Socket.io
    res.locals.nonce = res.locals.nonce; // Make nonce available in templates
    next();
});

// **Passport Initialization**
app.use(passport.initialize());
app.use(passport.session());

// **Configure the GitHub OAuth Strategy**
passport.use(new GitHubStrategy({
    clientID: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callbackURL: process.env.GITHUB_CALLBACK_URL
},
    async function (accessToken, refreshToken, profile, done) {
        try {
            // **User Handling:**
            // For MVP purposes, we're using the GitHub profile as the user object.
            // In a production app, you'd typically find or create a user in your database here.

            // **Attach the Access Token and Avatar URL to the Profile**
            profile.accessToken = accessToken;
            profile.avatar_url = profile.photos[0]?.value || 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png';
            profile.id = profile.id; // GitHub user ID

            return done(null, profile);
        } catch (error) {
            console.error('Error in GitHub Strategy:', error);
            return done(error, null);
        }
    }
));

// **Serialize User Data into the Session**
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// **Initialize Cache**
const cache = new NodeCache({ stdTTL: 600 }); // Cache for 10 minutes

// **Create HTTP Server and Initialize Socket.io**
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "http://localhost:5000", // Adjust if frontend is served from a different origin
        methods: ["GET", "POST"]
    }
});

// **Initialize Fine-Tuning Queue with Socket.io**
const fineTuningQueue = initializeFineTuningQueue(io);

// **Handle Socket.io Connections**
io.on('connection', (socket) => {
    console.log('A user connected');

    // **Listen for User Joining Their Personal Room**
    socket.on('join-room', (userId) => {
        socket.join(userId);
        console.log(`User ${userId} joined their room`);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

// **Helper Functions**

/**
 * Fetch User Repositories from GitHub
 * @param {object} user - Authenticated user object
 * @returns {Array} - Array of repository objects
 */
async function fetchUserRepositories(user) {
    const octokit = new Octokit({
        auth: user.accessToken
    });

    try {
        const reposResponse = await octokit.repos.listForAuthenticatedUser();
        const repos = reposResponse.data.map(repo => ({
            name: repo.name,
            html_url: repo.html_url,
            description: repo.description,
            stargazers_count: repo.stargazers_count,
            forks_count: repo.forks_count
        }));
        return repos;
    } catch (error) {
        console.error('Error fetching repositories:', error);
        throw error;
    }
}

/**
 * Fetch User's Fine-Tuning Jobs from the Database
 * @param {object} user - Authenticated user object
 * @returns {Array} - Array of job objects
 */
async function fetchUserJobs(user) {
    try {
        const jobs = await Job.findAll({
            where: { userId: user.id },
            order: [['createdAt', 'DESC']]
        });
        return jobs;
    } catch (error) {
        console.error('Error fetching jobs:', error);
        throw error;
    }
}

/**
 * Fetch API Usage Statistics
 * @returns {object} - API usage statistics
 */
async function fetchApiUsageStats() {
    try {
        const repositoriesCount = await Job.count(); // Total number of repositories integrated
        const modelsFineTunedCount = await Job.count({ where: { status: 'completed' } }); // Total fine-tuned models
        const activeUsersCount = await Job.findAll({ attributes: ['userId'], group: ['userId'] }).then(rows => rows.length); // Total active users

        return {
            repositories: repositoriesCount,
            modelsFineTuned: modelsFineTunedCount,
            activeUsers: activeUsersCount
        };
    } catch (error) {
        console.error('Error fetching API usage stats:', error);
        return {
            repositories: 0,
            modelsFineTuned: 0,
            activeUsers: 0
        };
    }
}

/**
 * Fetch Latest Fine-Tuning Jobs
 * @param {number} limit - Number of jobs to fetch
 * @returns {Array} - Array of latest job objects
 */
async function fetchLatestJobs(limit = 3) {
    try {
        const latestJobs = await Job.findAll({
            order: [['createdAt', 'DESC']],
            limit: limit
        });
        return latestJobs;
    } catch (error) {
        console.error('Error fetching latest jobs:', error);
        return [];
    }
}

// **Routes**

/**
 * @route   GET /
 * @desc    Render Homepage
 */
app.get('/', async (req, res) => {
    // **Fetch API Usage Statistics**
    const apiStats = await fetchApiUsageStats();

    // **Fetch Latest Jobs**
    const latestJobs = await fetchLatestJobs(3);

    res.render('homepage', {
        page: 'home',
        apiStats,
        latestJobs
    });
});

/**
 * @route   GET /auth/github
 * @desc    Initiate GitHub OAuth Authentication
 */
app.get('/auth/github', passport.authenticate('github', { scope: ['user', 'repo'] }));

/**
 * @route   GET /auth/github/callback
 * @desc    Handle GitHub OAuth Callback
 */
app.get('/auth/github/callback',
    passport.authenticate('github', { failureRedirect: '/', failureFlash: true }),
    (req, res) => {
        req.flash('success_msg', 'You are now logged in!');
        res.redirect('/dashboard');

        // **Join the User to Their Personal Socket.io Room**
        if (req.user && req.user.id) {
            io.to(req.user.id).emit('joined', { message: 'You have joined your personal room.' });
        }
    }
);

/**
 * @route   GET /dashboard
 * @desc    Render Dashboard (Protected Route)
 */
app.get('/dashboard', async (req, res) => {
    if (!req.isAuthenticated()) {
        req.flash('error_msg', 'Please log in to view this resource.');
        return res.redirect('/auth/github');
    }

    try {
        let repos = [];
        let hf_models = [];

        // Check if User Data is in Cache
        const cachedData = cache.get(req.user.username);
        if (cachedData) {
            repos = cachedData.repos;
            hf_models = cachedData.hf_models;
        } else {
            // Fetch Repositories from GitHub
            repos = await fetchUserRepositories(req.user);

            // Fetch Hugging Face Models if API Token is Set
            const hf_token = req.session.hf_token;
            console.log('Dashboard: HF Token:', hf_token); // Log the token in the session

            if (hf_token) {
                try {
                    const hf_response = await axios.get('https://huggingface.co/api/models', {
                        headers: {
                            'Authorization': `Bearer ${hf_token}`
                        }
                    });
                    console.log('Hugging Face API Response:', hf_response.data); // Add this log to check API response

                    hf_models = hf_response.data.map(model => ({
                        id: model.id,
                        name: model.modelId,
                        description: model.cardData?.description || 'No description provided.',
                        downloads: model.downloads
                    }));
                } catch (hfError) {
                    console.error('Error fetching Hugging Face models:', hfError);
                    req.flash('error_msg', 'Failed to load Hugging Face models.');
                }
            }

            // Cache the Data
            cache.set(req.user.username, { repos, hf_models });
        }

        // Fetch Job History from the Database
        const jobs = await fetchUserJobs(req.user);

        res.render('dashboard', {
            page: 'dashboard',
            repos,
            hf_models,
            jobs,
            nonce: res.locals.nonce // Pass nonce to the template
        });
    } catch (error) {
        console.error('Error rendering dashboard:', error);
        req.flash('error_msg', 'Failed to load dashboard.');
        res.redirect('/');
    }
});

/**
 * @route   GET /settings
 * @desc    Render Settings Page (Protected Route)
 */
app.get('/settings', (req, res) => {
    if (!req.isAuthenticated()) {
        req.flash('error_msg', 'Please log in to view this resource.');
        return res.redirect('/auth/github');
    }

    // Log to verify the token before rendering the page
    console.log('Rendering settings, HF Token:', req.session.hf_token);

    res.render('settings', {
        page: 'settings',
        hf_token: req.session.hf_token || '', // Pass the saved token or empty string
        nonce: res.locals.nonce // Pass nonce to the template if needed
    });
});

/**
 * @route   POST /settings
 * @desc    Handle Settings Form Submission (Protected Route)
 */
app.post('/settings', (req, res) => {
    if (!req.isAuthenticated()) {
        req.flash('error_msg', 'Please log in to perform this action.');
        return res.redirect('/auth/github');
    }

    const { hf_token } = req.body;

    // Check and log token submission
    console.log('Saving HF Token:', hf_token);

    if (hf_token) {
        req.session.hf_token = hf_token; // Save to session
        cache.del(req.user.username); // Clear cache to fetch updated models
        req.flash('success_msg', 'Hugging Face API token updated successfully.');
    } else {
        req.flash('error_msg', 'Please provide a valid Hugging Face API token.');
    }

    res.redirect('/dashboard'); // Redirect to dashboard after token is set
});

/**
 * @route   POST /fine-tune
 * @desc    Initiate Model Fine-Tuning (Protected Route)
 */
app.post('/fine-tune', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    const { repo_url, model_id } = req.body;

    if (!repo_url || !model_id) {
        return res.status(400).json({ message: 'Repository URL and Model ID are required.' });
    }

    const hf_token = req.session.hf_token;

    if (!hf_token) {
        return res.status(400).json({ message: 'Hugging Face API token is missing. Please set it in Settings.' });
    }

    try {
        // **Create a New Job Record in the Database**
        const newJob = await Job.create({
            userId: req.user.id,
            repo_url,
            model_id, // Ensure the model_id is passed as-is, without appending /fine-tune
            status: 'pending',
        });

        // **Initiate Fine-Tuning Process (Here you would send the request to Hugging Face)**
        const response = await axios.post(`https://api.huggingface.co/models/${model_id}/fine-tune`, {
            headers: {
                'Authorization': `Bearer ${hf_token}`
            },
            data: {
                repo_url
            }
        });

        await newJob.update({ status: 'in-progress', result: response.data });
        res.status(200).json({ message: 'Fine-tuning job initiated successfully.' });

    } catch (error) {
        console.error('Error during fine-tuning:', error.response?.data || error.message);
        await newJob.update({ status: 'failed', result: error.response?.data || error.message });
        res.status(500).json({ message: 'Fine-tuning failed.' });
    }
});


/**
 * @route   GET /logout
 * @desc    Logout User
 */
app.get('/logout', (req, res, next) => {
    req.logout(function (err) {
        if (err) {
            console.error('Logout Error:', err);
            return next(err);
        }
        req.flash('success_msg', 'You have logged out successfully.');
        res.redirect('/');
    });
});

// **Error Handling Routes**

/**
 * @route   * 
 * @desc    Handle 404 - Page Not Found
 */
app.use((req, res, next) => {
    res.status(404).render('404', { nonce: res.locals.nonce });
});

/**
 * @route   *
 * @desc    Handle 500 - Server Errors
 */
app.use((err, req, res, next) => {
    console.error('Unhandled Server Error:', err.stack);
    res.status(500).render('500', { nonce: res.locals.nonce });
});

// **Export io for Use in Other Files (e.g., queues/fineTuningQueue.js)**
module.exports = { io };

// **Start the Server**
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
