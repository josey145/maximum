const express = require('express');
const router = express.Router();
const { ensureAuthenticated } = require('../middleware/authMiddleware');
const db = require('../config/db');

router.get('/', ensureAuthenticated, async (req, res) => {
    try {
        // Get user's trading history (placeholder for future implementation)
        const trades = [];
        res.render('dashboard/dashboard', { 
            title: 'Dashboard - Maximum',
            trades 
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.render('dashboard/dashboard', { 
            title: 'Dashboard - Maximum',
            trades: [] 
        });
    }
});

module.exports = router;