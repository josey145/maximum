const mysql = require('mysql2/promise');
require('dotenv').config();

// If these are undefined, the app will log an error explaining why it failed.
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT) || 26648,
    waitForConnections: true,
    connectionLimit: 10,
    ssl: {
        rejectUnauthorized: false
    }
});

// Test connection
pool.getConnection()
    .then(connection => {
        console.log('Database connected successfully');
        connection.release();
    })
    .catch(err => {
        console.error('Database connection failed:', err);
    });

module.exports = pool;