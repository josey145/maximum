const mysql = require('mysql2/promise');
require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Check if CA certificate exists (for production/Render)
let sslConfig = { rejectUnauthorized: false };

const caPath = path.join(__dirname, 'ca.pem');
if (fs.existsSync(caPath)) {
    sslConfig = {
        ca: fs.readFileSync(caPath),
        rejectUnauthorized: true  // Aiven requires this
    };
} else if (process.env.DB_SSL_CA) {
    sslConfig = {
        ca: process.env.DB_SSL_CA,
        rejectUnauthorized: true
    };
}

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT) || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    ssl: sslConfig,
    connectTimeout: 30000,  // Increase timeout for cloud DB
    acquireTimeout: 30000
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