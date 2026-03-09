const express = require('express');
const router = express.Router();
const { ensureAdmin } = require('../middleware/authMiddleware');
const db = require('../config/db');
const telegramBot = require('../services/telegramBot');

router.get('/', ensureAdmin, async (req, res) => {
    try {
        const [users] = await db.execute(
            'SELECT id, username, email, role, created_at, blocked, email_verified FROM users ORDER BY created_at DESC'
        );
        
        // IMPORTANT: Pass currentUser here
        res.render('admin/dashboard', { 
            title: 'Admin Panel - Maximum',
            users: users,
            currentUser: req.session.user  // This is required!
        });
        
    } catch (error) {
        console.error('Admin dashboard error:', error);
        req.flash('error', 'Failed to load admin panel');
        res.redirect('/dashboard');
    }
});

router.post('/delete/:id', ensureAdmin, async (req, res) => {
    try {
        const userId = req.params.id;
        
        if (parseInt(userId) === req.session.user.id) {
            req.flash('error', 'You cannot delete your own account');
            return res.redirect('/admin');
        }

        await db.execute('DELETE FROM users WHERE id = ?', [userId]);
        
        await telegramBot.notifyAdminAction('User Deleted', {
            username: req.session.user.username,
            targetUserId: userId
        });

        req.flash('success', 'User deleted successfully');
        res.redirect('/admin');
    } catch (error) {
        console.error('Delete user error:', error);
        req.flash('error', 'Failed to delete user');
        res.redirect('/admin');
    }
});

router.post('/role/:id', ensureAdmin, async (req, res) => {
    try {
        const userId = req.params.id;
        const { role } = req.body;

        if (!['user', 'admin'].includes(role)) {
            req.flash('error', 'Invalid role');
            return res.redirect('/admin');
        }

        await db.execute('UPDATE users SET role = ? WHERE id = ?', [role, userId]);
        
        await telegramBot.notifyAdminAction(`Role changed to ${role}`, {
            username: req.session.user.username,
            targetUserId: userId
        });

        req.flash('success', 'User role updated successfully');
        res.redirect('/admin');
    } catch (error) {
        console.error('Update role error:', error);
        req.flash('error', 'Failed to update user role');
        res.redirect('/admin');
    }
});

router.post('/block/:id', ensureAdmin, async (req, res) => {
    try {
        const userId = req.params.id;
        
        if (parseInt(userId) === req.session.user.id) {
            req.flash('error', 'You cannot block yourself');
            return res.redirect('/admin');
        }

        await db.execute('UPDATE users SET blocked = 1 WHERE id = ?', [userId]);
        req.flash('success', 'User blocked successfully');
        res.redirect('/admin');
    } catch (error) {
        console.error('Block user error:', error);
        req.flash('error', 'Failed to block user');
        res.redirect('/admin');
    }
});

router.post('/unblock/:id', ensureAdmin, async (req, res) => {
    try {
        const userId = req.params.id;
        await db.execute('UPDATE users SET blocked = 0 WHERE id = ?', [userId]);
        req.flash('success', 'User unblocked successfully');
        res.redirect('/admin');
    } catch (error) {
        console.error('Unblock user error:', error);
        req.flash('error', 'Failed to unblock user');
        res.redirect('/admin');
    }
});

module.exports = router;