const bcrypt = require('bcryptjs');
const { validationResult } = require('express-validator');
const db = require('../config/db');
const telegramBot = require('../services/telegramBot');


const getLogin = (req, res) => {
    res.render('auth/login', { title: 'Login - Maximum' });
};

const postLogin = async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            req.flash('error', errors.array()[0].msg);
            return res.redirect('/login');
        }

        const { email, password } = req.body;

        const [users] = await db.execute(
            'SELECT * FROM users WHERE email = ?',
            [email]
        );

        if (users.length === 0) {
            req.flash('error', 'Invalid email or password');
            return res.redirect('/login');
        }

        const user = users[0];
        
        if (user.blocked) {
            req.flash('error', 'Your account has been suspended. Contact support.');
            return res.redirect('/login');
        }

        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            req.flash('error', 'Invalid email or password');
            return res.redirect('/login');
        }

        req.session.user = {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role
        };

        console.log('📞 Calling telegram notification...');

        try {
            const result = await telegramBot.notifyLogin({
                userId: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                ip: req.ip
            });
            console.log('📱 notifyLogin returned:', result);
        } catch (err) {
            console.error('❌ TELEGRAM THREW:', err.message);
            console.error(err.stack);
        }

console.log('✅ Past telegram call');

        console.log('✅ Login complete, redirecting...');

        req.flash('success', `Welcome back, ${user.username}!`);
        
        if (user.role === 'admin') {
            return res.redirect('/admin');
        }
        res.redirect('/dashboard');
    } catch (error) {
        console.error('❌ Login error:', error);
        req.flash('error', 'An error occurred during login');
        res.redirect('/login');
    }
};

const getRegister = (req, res) => {
    res.render('auth/register', { title: 'Register - Maximum' });
};

const postRegister = async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            req.flash('error', errors.array()[0].msg);
            return res.redirect('/register');
        }

        const { username, email, password } = req.body;

        const [existing] = await db.execute(
            'SELECT * FROM users WHERE email = ? OR username = ?',
            [email, username]
        );

        if (existing.length > 0) {
            req.flash('error', 'Email or username already exists');
            return res.redirect('/register');
        }

        const hashedPassword = await bcrypt.hash(password, 12);

        const [result] = await db.execute(
            'INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)',
            [username, email, hashedPassword, 'user']
        );

        const [countResult] = await db.execute('SELECT COUNT(*) as total FROM users');
        const totalUsers = countResult[0].total;

        // ✅ Notify Telegram — no duplicate require, use the top-level import
        await telegramBot.notifyNewRegistration({
            userId: result.insertId,   // ← use the real new user's ID
            username,
            email,
            ip: req.ip,
            totalUsers
        });

        req.flash('success', 'Account created! Please log in.');
        res.redirect('/login');

    } catch (error) {
        console.error('❌ Registration error:', error);
        req.flash('error', 'An error occurred during registration');
        res.redirect('/register');
    }
};

const logout = (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Logout error:', err);
        }
        res.redirect('/');
    });
};

module.exports = {
    getLogin,
    postLogin,
    getRegister,
    postRegister,
    logout
};