// backend/db.js

const { Sequelize } = require('sequelize');

// Initialize Sequelize with DATABASE_URL from .env
const sequelize = new Sequelize(process.env.DATABASE_URL, {
    dialect: 'postgres',
    protocol: 'postgres',
    logging: false, // Disable logging; enable if needed
    dialectOptions: process.env.NODE_ENV === 'production' ? {
        ssl: {
            require: true,
            rejectUnauthorized: false
        }
    } : {},
});

// Test the database connection
sequelize.authenticate()
    .then(() => {
        console.log('Connection to PostgreSQL has been established successfully.');
    })
    .catch(err => {
        console.error('Unable to connect to the PostgreSQL database:', err);
    });

// **Synchronize Sequelize Models**
sequelize.sync()
    .then(() => {
        console.log('All models were synchronized successfully.');
    })
    .catch(err => {
        console.error('An error occurred while synchronizing models:', err);
    });

// Export the Sequelize instance
module.exports = sequelize;
