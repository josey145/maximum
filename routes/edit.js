const express = require('express');
const router = express.Router();
const { ensureAuthenticated } = require('../middleware/authMiddleware');
const db = require('../config/db');

// GET /edit - Edit profile page
router.get('/', ensureAuthenticated, async (req, res) => {
    try {
        const [users] = await db.execute(
            'SELECT id, username, email, phone, dob, country, state, city, zip, address, currency FROM users WHERE id = ?',
            [req.session.user.id]
        );
        
        res.render('edit/edit', {
            title: 'Edit Profile - Maximum',
            user: users[0]
        });
    } catch (error) {
        console.error('Edit page error:', error);
        req.flash('error', 'Failed to load edit page');
        res.redirect('/profile');
    }
});

// POST /edit - Save profile changes
router.post('/', ensureAuthenticated, async (req, res) => {
    try {
        const { phone, dob, country, state, city, zip, address, currency } = req.body;
        
        await db.execute(
            `UPDATE users SET 
                phone = ?, 
                dob = ?, 
                country = ?, 
                state = ?, 
                city = ?, 
                zip = ?, 
                address = ?,
                currency = ?,
                updated_at = NOW()
            WHERE id = ?`,
            [phone, dob, country, state, city, zip, address, currency, req.session.user.id]
        );
        
        req.flash('success', 'Profile updated successfully');
        res.redirect('/profile');
    } catch (error) {
        console.error('Edit save error:', error);
        req.flash('error', 'Failed to save changes');
        res.redirect('/edit');
    }
});

module.exports = router;