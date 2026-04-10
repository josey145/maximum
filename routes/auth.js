const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const nodemailer = require('nodemailer');
const { validationResult } = require('express-validator');
const crypto = require('crypto');
const db = require('../config/db');
const { forwardAuthenticated } = require('../middleware/authMiddleware');
const { loginValidation } = require('../middleware/validation');
const telegramBot = require('../services/telegramBot');

// Helper to get site name
const getSiteName = async () => {
    try {
        const [settings] = await db.execute(
            "SELECT setting_value FROM site_settings WHERE setting_key = 'site_name'"
        );
        return settings[0]?.setting_value || 'Maximum';
    } catch (e) {
        return 'Maximum';
    }
};

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

// In-memory stores
const verificationCodes = new Map();
const passwordResetTokens = new Map(); // For forgot password

function generateCode() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

function generateResetToken() {
    return crypto.randomBytes(32).toString('hex');
}

// ── GET /login ─────────────────────────────────────────────────────────────
router.get('/login', forwardAuthenticated, async (req, res) => {
    const siteName = await getSiteName();
    res.render('auth/login', { 
        title: `Login - ${siteName}`,
        siteName 
    });
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
            req.flash('error', 'Your account has been blocked. Contact support.');
            return res.redirect('/login');
        }

        if (user.suspended) {
            req.flash('error', 'Your account has been suspended. Contact support.');
            return res.redirect('/login');
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            req.flash('error', 'Invalid email or password');
            return res.redirect('/login');
        }

        // Set session
        req.session.user = {
            id:               user.id,
            username:         user.username,
            email:            user.email,
            role:             user.role,
            kyc_status:       user.kyc_status,
            account_verified: user.account_verified,
            currency:         user.currency || 'USD',
            balance:          user.balance,
        };

        // Telegram notification
        try {
            console.log('🔑 User logged in:', user.username, '| Role:', user.role);
            const siteName = await getSiteName();

            const message = 
                `🔑 *User Login*\n` +
                `👤 Username: ${user.username}\n` +
                `📧 Email: ${user.email}\n` +
                `🎭 Role: ${user.role.toUpperCase()}\n` +
                `🌍 IP: ${req.ip}\n` +
                `🕐 Time: ${new Date().toUTCString()}`;

            if (typeof telegramBot.notifyLogin === 'function') {
                await telegramBot.notifyLogin({
                    userId:   user.id,
                    username: user.username,
                    email:    user.email,
                    role:     user.role,
                    ip:       req.ip
                });
            } else {
                await telegramBot.notifyAdminAction('User Login', {
                    username: user.username,
                    email:    user.email,
                    role:     user.role,
                    ip:       req.ip
                });
            }
        } catch (tgErr) {
            console.error('❌ Telegram login notify failed:', tgErr.message);
        }

        if (user.role === 'admin') {
            req.flash('success', `Welcome back, ${user.username}!`);
            return res.redirect('/admin');
        }

        if (res.locals.site && res.locals.site.maintenance_mode) {
            req.session.destroy();
            return res.status(503).render('maintenance', {
                site: res.locals.site,
                title: 'Under Maintenance'
            });
        }

        req.flash('success', `Welcome back, ${user.username}!`);
        return res.redirect('/dashboard');

    } catch (error) {
        console.error('Login error:', error);
        req.flash('error', 'An error occurred during login');
        res.redirect('/login');
    }
});

// ── GET /register ──────────────────────────────────────────────────────────
router.get('/register', forwardAuthenticated, async (req, res) => {
    const siteName = await getSiteName();
    res.render('auth/register', { 
        title: `Register - ${siteName}`,
        siteName 
    });
});

// ── POST /register/send-code  (AJAX) ──────────────────────────────────────
router.post('/register/send-code', async (req, res) => {
    try {
        const { email } = req.body;
        const siteName = await getSiteName();

        if (!email || !email.includes('@')) {
            return res.json({ success: false, message: 'Invalid email address.' });
        }

        const [existing] = await db.execute('SELECT id FROM users WHERE email = ?', [email]);
        if (existing.length > 0) {
            return res.json({ success: false, message: 'This email is already registered.' });
        }

        const code = generateCode();
        const expiresAt = Date.now() + 10 * 60 * 1000;
        verificationCodes.set(email, { code, expiresAt });

        console.log(`📧 Verification code for ${email}: ${code}`);

        try {
            await transporter.sendMail({
                from: `"${siteName} Platform" <${process.env.EMAIL_USER}>`,
                to: email,
                subject: `Your ${siteName} Verification Code`,
                html: `
                    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#0a0a0f;color:#f4f4f5;padding:40px;border-radius:16px;">
                        <h2 style="color:#8b5cf6;margin-bottom:8px;">${siteName} Platform</h2>
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

// ── POST /register ─────────────────────────────────────────────────────────
router.post('/register', upload.fields([
    { name: 'idFront', maxCount: 1 },
    { name: 'idBack',  maxCount: 1 }
]), async (req, res) => {
    try {
        const siteName = await getSiteName();
        const {
            username, email, password, phone, dob,
            currency, country, state, city, zip, address,
            idType, idNumber, verifyCode
        } = req.body;

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
              (username, email, password, role, kyc_status)
            VALUES (?, ?, ?, 'user', 'pending')
        `, [username, email, hashedPassword]);

        const [countResult] = await db.execute('SELECT COUNT(*) as total FROM users');
        const totalUsers = countResult[0].total;

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

// ─────────────────────────────────────────────────────────────────────────────
// FORGOT PASSWORD ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /forgot-password - Show forgot password form
router.get('/forgot-password', forwardAuthenticated, async (req, res) => {
    const siteName = await getSiteName();
    res.render('auth/forgot-password', {
        title: `Forgot Password - ${siteName}`,
        siteName
    });
});

// POST /forgot-password - Send reset link
router.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        const siteName = await getSiteName();

        if (!email || !email.includes('@')) {
            req.flash('error', 'Please enter a valid email address.');
            return res.redirect('/forgot-password');
        }

        const [users] = await db.execute('SELECT id, username, email FROM users WHERE email = ?', [email]);
        
        if (users.length === 0) {
            // Don't reveal if email exists
            req.flash('success', 'If an account exists with this email, you will receive a password reset link.');
            return res.redirect('/login');
        }

        const user = users[0];
        const token = generateResetToken();
        const expiresAt = Date.now() + 60 * 60 * 1000; // 1 hour

        passwordResetTokens.set(token, {
            userId: user.id,
            email: user.email,
            expiresAt
        });

        const resetUrl = `${req.protocol}://${req.get('host')}/reset-password?token=${token}`;

        try {
            await transporter.sendMail({
                from: `"${siteName} Support" <${process.env.EMAIL_USER}>`,
                to: email,
                subject: `Password Reset - ${siteName}`,
                html: `
                    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#0a0a0f;color:#f4f4f5;padding:40px;border-radius:16px;">
                        <h2 style="color:#8b5cf6;margin-bottom:8px;">${siteName}</h2>
                        <p style="color:#a1a1aa;margin-bottom:32px;">Password Reset Request</p>
                        
                        <div style="background:#111118;border:1px solid #1e1e2e;border-radius:12px;padding:32px;">
                            <p style="color:#f4f4f5;font-size:15px;margin-bottom:24px;">
                                Hello ${user.username},<br><br>
                                You requested a password reset. Click the button below to reset your password:
                            </p>
                            
                            <div style="text-align:center;margin:32px 0;">
                                <a href="${resetUrl}" 
                                   style="display:inline-block;background:linear-gradient(135deg,#8b5cf6,#6d28d9);
                                          color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;
                                          font-size:15px;font-weight:600;">
                                    Reset Password
                                </a>
                            </div>
                            
                            <p style="color:#52525b;font-size:13px;margin-top:24px;">
                                Or copy this link:<br>
                                <span style="color:#8b5cf6;word-break:break-all;">${resetUrl}</span>
                            </p>
                            
                            <p style="color:#52525b;font-size:12px;margin-top:24px;">
                                This link expires in 1 hour. If you didn't request this, please ignore this email.
                            </p>
                        </div>
                    </div>
                `
            });
            console.log(`✅ Password reset email sent to ${email}`);
        } catch (mailErr) {
            console.error('Failed to send reset email:', mailErr.message);
            req.flash('error', 'Failed to send reset email. Please try again.');
            return res.redirect('/forgot-password');
        }

        // Notify admin
        try {
            await telegramBot.notifyAdminAction('Password Reset Requested', {
                username: user.username,
                email: user.email,
                ip: req.ip
            });
        } catch (tgErr) {
            console.error('Telegram notify failed:', tgErr.message);
        }

        req.flash('success', 'If an account exists with this email, you will receive a password reset link.');
        res.redirect('/login');

    } catch (error) {
        console.error('Forgot password error:', error);
        req.flash('error', 'An error occurred. Please try again.');
        res.redirect('/forgot-password');
    }
});

// GET /reset-password - Show reset password form
router.get('/reset-password', forwardAuthenticated, async (req, res) => {
    try {
        const { token } = req.query;
        const siteName = await getSiteName();

        if (!token) {
            req.flash('error', 'Invalid or expired reset link.');
            return res.redirect('/forgot-password');
        }

        const resetData = passwordResetTokens.get(token);
        
        if (!resetData || Date.now() > resetData.expiresAt) {
            passwordResetTokens.delete(token);
            req.flash('error', 'This reset link has expired. Please request a new one.');
            return res.redirect('/forgot-password');
        }

        res.render('auth/reset-password', {
            title: `Reset Password - ${siteName}`,
            siteName,
            token
        });

    } catch (error) {
        console.error('Reset password page error:', error);
        req.flash('error', 'An error occurred. Please try again.');
        res.redirect('/forgot-password');
    }
});

// POST /reset-password - Update password
router.post('/reset-password', async (req, res) => {
    try {
        const { token, password, confirmPassword } = req.body;
        const siteName = await getSiteName();

        if (!token) {
            req.flash('error', 'Invalid reset token.');
            return res.redirect('/forgot-password');
        }

        if (!password || password.length < 8) {
            req.flash('error', 'Password must be at least 8 characters.');
            return res.redirect(`/reset-password?token=${token}`);
        }

        if (password !== confirmPassword) {
            req.flash('error', 'Passwords do not match.');
            return res.redirect(`/reset-password?token=${token}`);
        }

        const resetData = passwordResetTokens.get(token);
        
        if (!resetData || Date.now() > resetData.expiresAt) {
            passwordResetTokens.delete(token);
            req.flash('error', 'This reset link has expired. Please request a new one.');
            return res.redirect('/forgot-password');
        }

        const hashedPassword = await bcrypt.hash(password, 12);
        
        await db.execute(
            'UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?',
            [hashedPassword, resetData.userId]
        );

        // Clear token
        passwordResetTokens.delete(token);

        // Send confirmation email
        try {
            await transporter.sendMail({
                from: `"${siteName} Support" <${process.env.EMAIL_USER}>`,
                to: resetData.email,
                subject: `Password Changed - ${siteName}`,
                html: `
                    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#0a0a0f;color:#f4f4f5;padding:40px;border-radius:16px;">
                        <h2 style="color:#8b5cf6;margin-bottom:8px;">${siteName}</h2>
                        <p style="color:#a1a1aa;margin-bottom:32px;">Password Changed Successfully</p>
                        
                        <div style="background:#111118;border:1px solid #1e1e2e;border-radius:12px;padding:32px;">
                            <p style="color:#f4f4f5;font-size:15px;margin-bottom:24px;">
                                Your password has been successfully changed.<br><br>
                                If you didn't make this change, please contact support immediately.
                            </p>
                            
                            <div style="text-align:center;margin:32px 0;">
                                <a href="${req.protocol}://${req.get('host')}/login" 
                                   style="display:inline-block;background:linear-gradient(135deg,#22c55e,#16a34a);
                                          color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;
                                          font-size:15px;font-weight:600;">
                                    Login Now
                                </a>
                            </div>
                        </div>
                    </div>
                `
            });
        } catch (mailErr) {
            console.error('Failed to send confirmation email:', mailErr.message);
        }

        req.flash('success', 'Your password has been reset successfully. Please login with your new password.');
        res.redirect('/login');

    } catch (error) {
        console.error('Reset password error:', error);
        req.flash('error', 'An error occurred. Please try again.');
        res.redirect('/forgot-password');
    }
});

// ── POST /logout ───────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) console.error('Logout error:', err);
        res.redirect('/');
    });
});

console.log('✅ Auth routes loaded');

module.exports = router;