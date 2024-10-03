// backend/queues/fineTuningQueue.js

const Bull = require('bull');
const axios = require('axios');
const Job = require('../models/job');

/**
 * Initializes the Fine-Tuning Queue.
 * @param {SocketIO.Server} io - The Socket.io server instance.
 * @returns {Bull.Queue} - The initialized Bull queue.
 */
function initializeFineTuningQueue(io) {
    const fineTuningQueue = new Bull('fine-tuning', {
        redis: {
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: process.env.REDIS_PORT || 6379,
        },
    });

    // Process jobs in the queue
    fineTuningQueue.process(async (job, done) => {
        const { hf_token, model_id, repo_url, userId, jobId } = job.data;
        console.log(`Processing job ${jobId} for user ${userId} with model ${model_id} and repo ${repo_url}`);

        try {
            // **Update job status to 'in-progress'**
            await Job.update({ status: 'in-progress' }, { where: { id: jobId } });

            // **Make API call to Hugging Face to initiate fine-tuning**
            // Ensure that 'model_id' corresponds to a valid model repository on Hugging Face
            const response = await axios.post(`https://api-inference.huggingface.co/models/${model_id}/fine-tune`, {
                repository: repo_url,
                // Add other necessary parameters here based on Hugging Face's API
                // Example parameters:
                // task: 'text-classification',
                // parameters: { ... }
            }, {
                headers: {
                    'Authorization': `Bearer ${hf_token}`,
                    'Content-Type': 'application/json',
                },
            });

            // **Update job status to 'completed' and store result**
            await Job.update({ status: 'completed', result: response.data }, { where: { id: jobId } });

            // **Emit a completion event to the user via Socket.io**
            io.to(userId).emit('fine-tuning-completed', { jobId: job.id, data: response.data });

            console.log(`Job ${jobId} completed successfully.`);
            done(null, response.data);
        } catch (error) {
            console.error(`Error during fine-tuning for job ${jobId}:`, error.response ? error.response.data : error.message);

            // **Update job status to 'failed' and store error message**
            await Job.update({ status: 'failed', result: error.response ? error.response.data.error : error.message }, { where: { id: jobId } });

            // **Emit a failure event to the user via Socket.io**
            io.to(userId).emit('fine-tuning-failed', { jobId: job.id, error: error.response ? error.response.data.error : error.message });

            done(new Error('Fine-tuning failed'));
        }
    });

    // On job completion
    fineTuningQueue.on('completed', (job, result) => {
        console.log(`Job ${job.id} completed successfully.`);
    });

    // On job failure
    fineTuningQueue.on('failed', (job, err) => {
        console.log(`Job ${job.id} failed with error: ${err.message}`);
    });

    return fineTuningQueue;
}

module.exports = initializeFineTuningQueue;
