// backend/models/job.js

const { DataTypes } = require('sequelize');
const sequelize = require('../db'); // Import sequelize from db.js

const Job = sequelize.define('Job', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
    },
    userId: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    repo_url: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    model_id: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    status: {
        type: DataTypes.ENUM('pending', 'in-progress', 'completed', 'failed'),
        defaultValue: 'pending',
    },
    result: {
        type: DataTypes.JSONB,
    },
    createdAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
    },
}, {
    tableName: 'jobs',
    timestamps: false,
});

module.exports = Job;
