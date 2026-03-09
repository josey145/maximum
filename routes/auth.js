const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const nodemailer = require('nodemailer');
const { validationResult } = require('express-validator');
const db = require('../config/db');
const { forwardAuthenticated } = require('../middleware/authMiddleware');
const { loginValidation } = require('../middleware/validation');
const telegramBot = require('../services/telegramBot');

// ── File upload config ─────────────────────────────────────────────────────
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/ids/'),
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, unique + path.extname(file.originalname));
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = /jpeg|jpg|png|pdf/;
        const ok = allowed.test(path.extname(file.originalname).toLowerCase());
        ok ? cb(null, true) : cb(new Error('Only JPG, PNG or PDF files allowed'));
    }
});

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});
// In-memory verification code store { email: { code, expiresAt } }
const verificationCodes = new Map();

function generateCode() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

// ── GET /login ─────────────────────────────────────────────────────────────
router.get('/login', forwardAuthenticated, (req, res) => {
    res.render('auth/login', { title: 'Login - Maximum' });
});

// ── POST /login ────────────────────────────────────────────────────────────
router.post('/login', loginValidation, async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            req.flash('error', errors.array()[0].msg);
            return res.redirect('/login');
        }

        const { email, password } = req.body;
        const [users] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);

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

        // Notify Telegram
        try {
            console.log('🔑 User logged in:', user.username);
            await telegramBot.notifyLogin({
                userId: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                ip: req.ip
            });
        } catch (tgErr) {
            console.error('Telegram login notify failed:', tgErr.message);
        }

        req.flash('success', `Welcome back, ${user.username}!`);
        res.redirect(user.role === 'admin' ? '/admin' : '/dashboard');
    } catch (error) {
        console.error('Login error:', error);
        req.flash('error', 'An error occurred during login');
        res.redirect('/login');
    }
});

// ── GET /register ──────────────────────────────────────────────────────────
router.get('/register', forwardAuthenticated, (req, res) => {
    res.render('auth/register', { title: 'Register - Maximum' });
});

// ── POST /register/send-code  (AJAX) ──────────────────────────────────────
router.post('/register/send-code', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email || !email.includes('@')) {
            return res.json({ success: false, message: 'Invalid email address.' });
        }

        const [existing] = await db.execute('SELECT id FROM users WHERE email = ?', [email]);
        if (existing.length > 0) {
            return res.json({ success: false, message: 'This email is already registered.' });
        }

        const code = generateCode();
        const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
        verificationCodes.set(email, { code, expiresAt });

        console.log(`📧 Verification code for ${email}: ${code}`);

        // Send email to user
        try {
            await transporter.sendMail({
                from: `"Maximum Platform" <${process.env.EMAIL_USER}>`,
                to: email,
                subject: 'Your Maximum Verification Code',
                html: `
                    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#0a0a0f;color:#f4f4f5;padding:40px;border-radius:16px;">
                        <h2 style="color:#8b5cf6;margin-bottom:8px;">Maximum Platform</h2>
                        <p style="color:#a1a1aa;margin-bottom:32px;">Your email verification code</p>
                        <div style="background:#111118;border:1px solid #1e1e2e;border-radius:12px;padding:32px;text-align:center;">
                            <p style="color:#52525b;font-size:14px;margin-bottom:16px;">Your verification code is:</p>
                            <div style="font-size:48px;font-weight:800;letter-spacing:16px;color:#8b5cf6;">${code}</div>
                            <p style="color:#52525b;font-size:13px;margin-top:16px;">Expires in 10 minutes</p>
                        </div>
                        <p style="color:#3f3f5a;font-size:12px;margin-top:24px;">If you did not request this, please ignore this email.</p>
                    </div>
                `
            });
            console.log(`✅ Verification email sent to ${email}`);
        } catch (mailErr) {
            console.error('Email send failed:', mailErr.message);
        }

        // Notify admin via Telegram with the code
        try {
            await telegramBot.notifyNewRegistration({
                userId: 'PENDING',
                username: 'CODE_SENT',
                email: email,
                ip: req.ip,
                totalUsers: 0,
                message: `🔐 Verification code sent to ${email}: ${code}`
            });
        } catch (tgErr) {
            console.error('Telegram code notify failed:', tgErr.message);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Send code error:', error);
        res.json({ success: false, message: 'Failed to send verification code.' });
    }
});

// ── POST /register  (final form submission) ────────────────────────────────
router.post('/register', upload.fields([
    { name: 'idFront', maxCount: 1 },
    { name: 'idBack',  maxCount: 1 }
]), async (req, res) => {
    try {
        const {
            username, email, password, phone, dob,
            currency, country, state, city, zip, address,
            idType, idNumber, verifyCode
        } = req.body;

        // Validate verification code
        const stored = verificationCodes.get(email);
        if (!stored) {
            req.flash('error', 'Verification code expired or not found. Please try again.');
            return res.redirect('/register');
        }
        if (Date.now() > stored.expiresAt) {
            verificationCodes.delete(email);
            req.flash('error', 'Verification code has expired. Please request a new one.');
            return res.redirect('/register');
        }
        if (stored.code !== verifyCode) {
            req.flash('error', 'Invalid verification code. Please check and try again.');
            return res.redirect('/register');
        }
        verificationCodes.delete(email);

        // Check duplicates
        const [existing] = await db.execute(
            'SELECT id FROM users WHERE email = ? OR username = ?',
            [email, username]
        );
        if (existing.length > 0) {
            req.flash('error', 'Email or username already exists.');
            return res.redirect('/register');
        }

        const hashedPassword = await bcrypt.hash(password, 12);
        const idFrontPath = req.files?.idFront?.[0]?.filename || null;
        const idBackPath  = req.files?.idBack?.[0]?.filename  || null;

        const [result] = await db.execute(`
            INSERT INTO users
              (username, email, password, phone, dob, currency, country, state, city, zip, address,
               id_type, id_number, id_front, id_back, role, kyc_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', 'pending')
        `, [username, email, hashedPassword, phone, dob, currency, country,
            state, city, zip, address, idType, idNumber, idFrontPath, idBackPath]);

        const [countResult] = await db.execute('SELECT COUNT(*) as total FROM users');
        const totalUsers = countResult[0].total;

        // Notify Telegram
        try {
            console.log('📝 New user registered:', username);
            await telegramBot.notifyNewRegistration({
                userId: result.insertId,
                username: username,
                email: email,
                phone: phone,
                country: country,
                ip: req.ip,
                totalUsers: totalUsers
            });
        } catch (tgErr) {
            console.error('Telegram registration notify failed:', tgErr.message);
        }

        req.flash('success', 'Account created successfully! Please log in.');
        res.redirect('/login');

    } catch (error) {
        console.error('Registration error:', error);
        req.flash('error', 'An error occurred during registration. Please try again.');
        res.redirect('/register');
    }
});

console.log('✅ Auth routes loaded');
// Temporary simple register for testing
router.post('/register-simple', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        
        const hashedPassword = await bcrypt.hash(password, 12);
        
        const [result] = await db.execute(
            'INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)',
            [username, email, hashedPassword, 'user']
        );

        // Notify Telegram
        try {
            await telegramBot.notifyNewRegistration({
                userId: result.insertId,
                username: username,
                email: email,
                ip: req.ip,
                totalUsers: 1
            });
            console.log('✅ Telegram notification sent');
        } catch (tgErr) {
            console.error('❌ Telegram failed:', tgErr.message);
        }

        req.flash('success', 'Account created! Please login.');
        res.redirect('/login');
    } catch (error) {
        console.error(error);
        req.flash('error', 'Registration failed');
        res.redirect('/register');
    }
});

// ── POST /logout ───────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) console.error('Logout error:', err);
        res.redirect('/');
    });
});

module.exports = router;