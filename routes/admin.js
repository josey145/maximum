const express = require('express');
const router = express.Router();
const { ensureAdmin } = require('../middleware/authMiddleware');
const { ensureAuthenticated } = require('../middleware/authMiddleware');
const { clearSettingsCache } = require('../middleware/siteSettings');
const db = require('../config/db');

// ✅ BOT SEPARATION:
// telegramBot  → Admin-only private bot. Notifies admin of ALL actions.
// signalBot    → Client-facing bot. Sends trading signals and withdrawal codes to clients ONLY.
const telegramBot = require('../services/telegramBot');
const signalBot   = require('../services/signalBot');
const emailService = require('../services/emailService');


// ==================== HELPERS ====================


const getSiteNameForEmail = async () => {
    try {
        const [settings] = await db.execute(
            "SELECT setting_value FROM site_settings WHERE setting_key = 'site_name'"
        );
        return settings[0]?.setting_value || 'Maximum';
    } catch (e) {
        return 'Maximum';
    }
};

// Helper to get site name for emails
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

const generateCode = () => Math.floor(100000 + Math.random() * 900000).toString();

const logSystemEvent = async (level, message, metadata = {}) => {
    try {
        await db.execute(
            'INSERT INTO system_logs (level, message, metadata) VALUES (?, ?, ?)',
            [level, message, JSON.stringify(metadata || {})]
        );
    } catch (err) {
        console.error('Failed to log system event:', err);
    }
};

// Helper to get unread message count for navbar
const getUnreadCount = async () => {
    try {
        const [[{ count }]] = await db.execute(`
            SELECT COUNT(*) as count 
            FROM user_messages 
            WHERE is_from_admin = FALSE AND status = 'unread'
        `);
        return count;
    } catch (error) {
        console.error('Error fetching unread count:', error);
        return 0;
    }
};

// ==================== EXISTING EMAIL TEMPLATE (KEEP AS IS) ====================
// ==================== EXISTING EMAIL TEMPLATE (KEEP AS IS) ====================
// This is for receipts/transactions - DO NOT MODIFY
const emailTemplate = ({
    badge, badgeColor,
    username, intro,
    amountDisplay, amountColor,
    rows, footerNote,
    siteName = 'Maximum'  // Add default parameter
}) => {
    const year = new Date().getFullYear();
    const rowsHtml = rows.map(([label, val, color]) =>
        `<tr>
            <td style="padding:10px 0;color:#6b7280;font-size:13px;border-bottom:1px solid #1e1e2e;">${label}</td>
            <td style="padding:10px 0;font-size:13px;text-align:right;border-bottom:1px solid #1e1e2e;font-weight:600;color:${color || '#f4f4f5'};">${val}</td>
        </tr>`
    ).join('');

    return `
<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#0a0a0f;padding:0;border-radius:16px;overflow:hidden;">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#8b5cf6,#6d28d9);padding:32px 40px;text-align:center;">
        <h1 style="margin:0;color:#fff;font-size:22px;letter-spacing:2px;font-weight:800;">${siteName.toUpperCase()}</h1>
        <p style="margin:4px 0 0;color:rgba(255,255,255,0.65);font-size:12px;letter-spacing:1px;text-transform:uppercase;">Trading Platform</p>
    </div>

    <!-- Badge + Greeting -->
    <div style="background:#111118;padding:32px 40px 0;">
        <div style="display:inline-block;background:${badgeColor}22;border:1px solid ${badgeColor}55;border-radius:20px;padding:5px 16px;margin-bottom:20px;">
            <span style="color:${badgeColor};font-size:12px;font-weight:700;letter-spacing:1px;">● ${badge}</span>
        </div>
        <p style="color:#a1a1aa;font-size:15px;margin:0 0 24px;line-height:1.6;">
            Hello <strong style="color:#f4f4f5;">${username}</strong>, ${intro}
        </p>
    </div>

    <!-- Amount Box -->
    <div style="background:#111118;padding:0 40px 24px;">
        <div style="background:#0d0d14;border:1px solid #1e1e2e;border-left:4px solid ${amountColor};border-radius:12px;padding:28px;text-align:center;">
            <p style="color:#52525b;font-size:11px;text-transform:uppercase;letter-spacing:2px;margin:0 0 10px;">Transaction Amount</p>
            <p style="color:${amountColor};font-size:44px;font-weight:800;margin:0;font-family:'Courier New',monospace;letter-spacing:2px;">${amountDisplay}</p>
        </div>
    </div>

    <!-- Details Table -->
    <div style="background:#111118;padding:0 40px 28px;">
        <table style="width:100%;border-collapse:collapse;">${rowsHtml}</table>
    </div>

    <!-- Footer -->
    <div style="background:#0d0d14;border-top:1px solid #1e1e2e;padding:24px 40px;text-align:center;">
        <p style="color:#3f3f5a;font-size:12px;margin:0;line-height:1.6;">${footerNote}</p>
        <p style="color:#2a2a40;font-size:11px;margin:10px 0 0;">© ${year} ${siteName} · All rights reserved.</p>
    </div>

</div>`;
};

// ==================== NEW MESSAGE TEMPLATE (CLEAN STYLE) ====================
// This is for messages/warnings - NEW TEMPLATE
const messageTemplate = ({
    badge, badgeColor,
    username, intro,
    rows, footerNote,
    siteName = 'Maximum',  // Add default parameter
    siteUrl = 'https://yourdomain.com',
    buttonText = 'View Message',
    buttonUrl = '/messages'
}) => {
    const year = new Date().getFullYear();
    
    // Build rows HTML if provided
    const rowsHtml = rows && rows.length > 0 ? rows.map(([label, val]) =>
        `<tr>
            <td style="padding:12px 0;border-bottom:1px solid #e5e7eb;">
                <span style="color:#6b7280;font-size:13px;">${label}</span>
            </td>
            <td style="padding:12px 0;border-bottom:1px solid #e5e7eb;text-align:right;">
                <span style="color:#111827;font-size:13px;font-weight:500;">${val}</span>
            </td>
        </tr>`
    ).join('') : '';

    // Build message body
    const messageBody = intro ? `
        <div style="background:#f9fafb;border-radius:8px;padding:20px;margin:20px 0;">
            <p style="color:#374151;font-size:15px;line-height:1.7;margin:0;">${intro}</p>
        </div>
    ` : '';

    // Build details table if there are rows
    const detailsTable = rowsHtml ? `
        <table style="width:100%;border-collapse:collapse;margin:20px 0;">
            ${rowsHtml}
        </table>
    ` : '';

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${badge}</title>
</head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
    <table role="presentation" style="width:100%;border-collapse:collapse;">
        <tr>
            <td align="center" style="padding:40px 20px;">
                <table role="presentation" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px -1px rgba(0,0,0,0.1);">
                    
                    <!-- Header -->
                    <tr>
                        <td style="background:linear-gradient(135deg,#8b5cf6,#6d28d9);padding:32px 40px;text-align:center;">
                            <h1 style="margin:0;color:#fff;font-size:24px;font-weight:700;letter-spacing:-0.5px;">${siteName}</h1>
                            <p style="margin:8px 0 0;color:rgba(255,255,255,0.8);font-size:13px;">Trading Platform</p>
                        </td>
                    </tr>
                    
                    <!-- Badge -->
                    <tr>
                        <td style="padding:32px 40px 0;">
                            <span style="display:inline-block;background:${badgeColor}15;color:${badgeColor};padding:6px 16px;border-radius:20px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">
                                ● ${badge}
                            </span>
                        </td>
                    </tr>
                    
                    <!-- Greeting -->
                    <tr>
                        <td style="padding:24px 40px 0;">
                            <p style="margin:0;color:#374151;font-size:16px;line-height:1.6;">
                                Hello <strong style="color:#111827;">${username}</strong>,
                            </p>
                        </td>
                    </tr>
                    
                    <!-- Message Body -->
                    <tr>
                        <td style="padding:0 40px;">
                            ${messageBody}
                            ${detailsTable}
                        </td>
                    </tr>
                    
                    <!-- CTA Button -->
                    <tr>
                        <td style="padding:0 40px 32px;">
                            <div style="text-align:center;margin-top:24px;">
                                <a href="${siteUrl}${buttonUrl}" style="display:inline-block;background:linear-gradient(135deg,#8b5cf6,#6d28d9);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:600;">
                                    ${buttonText}
                                </a>
                            </div>
                        </td>
                    </tr>
                    
                    <!-- Footer -->
                    <tr>
                        <td style="background:#f9fafb;padding:24px 40px;text-align:center;border-top:1px solid #e5e7eb;">
                            <p style="margin:0 0 8px;color:#6b7280;font-size:13px;line-height:1.5;">
                                ${footerNote || 'Thank you for trading with us.'}
                            </p>
                            <p style="margin:8px 0 0;color:#9ca3af;font-size:12px;">
                                © ${year} ${siteName} · All rights reserved
                            </p>
                            <p style="margin:16px 0 0;">
                                <a href="${siteUrl}" style="color:#8b5cf6;text-decoration:none;font-size:13px;">Visit Website</a>
                            </p>
                        </td>
                    </tr>
                    
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;
};
// ==================== DASHBOARD ====================

router.get('/', ensureAdmin, async (req, res) => {
    try {
        const [users] = await db.execute(`
            SELECT 
                id, username, email, role, created_at, blocked, suspended,
                email_verified, account_verified, kyc_status,
                trading_mode, balance, withdrawal_code, withdrawal_code_expires,
                phone, country
            FROM users
            ORDER BY created_at DESC
        `);

        const [signals] = await db.execute(`
            SELECT s.*, u.username as admin_username
            FROM trading_signals s
            JOIN users u ON s.admin_id = u.id
            WHERE s.status = 'active'
            ORDER BY s.created_at DESC
        `);

        const [adminPositions] = await db.execute(`
            SELECT t.*, p.name as pair_name, p.symbol
            FROM forex_trades t
            JOIN forex_pairs p ON t.pair_id = p.id
            WHERE t.user_id = ? AND t.status = 'open'
            ORDER BY t.opened_at DESC
        `, [req.session.user.id]);

        const [adminHistory] = await db.execute(`
            SELECT t.*, p.name as pair_name
            FROM forex_trades t
            JOIN forex_pairs p ON t.pair_id = p.id
            WHERE t.user_id = ? AND t.status = 'closed'
            ORDER BY t.closed_at DESC
            LIMIT 10
        `, [req.session.user.id]);

        const [logs] = await db.execute(`
            SELECT * FROM system_logs
            ORDER BY created_at DESC
            LIMIT 50
        `);

        const [[withdrawalStats]] = await db.execute(`
            SELECT
                COUNT(*) as total_pending,
                SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END) as pending_amount
            FROM transactions
            WHERE type = 'withdrawal' AND status = 'pending'
        `);

        const [[stats]] = await db.execute(`
            SELECT
                COUNT(*) as total_users,
                SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) as admin_count,
                SUM(CASE WHEN DATE(created_at) = CURDATE() THEN 1 ELSE 0 END) as new_today,
                SUM(CASE WHEN kyc_status = 'approved' THEN 1 ELSE 0 END) as verified_kyc,
                SUM(CASE WHEN suspended = 1 THEN 1 ELSE 0 END) as suspended_count,
                SUM(CASE WHEN account_verified = 1 THEN 1 ELSE 0 END) as verified_accounts
            FROM users
        `);

        // Get unread count for navbar
        const unreadCount = await getUnreadCount();

        res.render('admin/dashboard', {
            title: 'Admin Panel',
            users,
            currentUser: req.session.user,
            signals:        signals        || [],
            adminPositions: adminPositions || [],
            adminHistory:   adminHistory   || [],
            logs:           logs           || [],
            stats:          stats          || {},
            withdrawalStats: withdrawalStats || { total_pending: 0, pending_amount: 0 },
            signalBotConfigured: typeof signalBot !== 'undefined' ? signalBot.isConfigured() : false,
            unreadCount
        });

    } catch (error) {
        console.error('Admin dashboard error:', error);
        req.flash('error', 'Failed to load admin panel: ' + error.message);
        res.redirect('/dashboard');
    }
});


// ==================== USER MANAGEMENT ====================

router.post('/verify-account/:id', ensureAdmin, async (req, res) => {
    try {
        const userId = req.params.id;
        await db.execute('UPDATE users SET account_verified = 1, updated_at = NOW() WHERE id = ?', [userId]);
        const [user] = await db.execute('SELECT username FROM users WHERE id = ?', [userId]);
        await telegramBot.notifyAdminAction('Account Verified', { admin: req.session.user.username, targetUser: user[0].username });
        req.flash('success', `Account verified for ${user[0].username}`);
    } catch (error) {
        req.flash('error', error.message);
    }
    res.redirect('/admin');
});

router.post('/verify-kyc/:id', ensureAdmin, async (req, res) => {
    try {
        const userId = req.params.id;
        const { action } = req.body;
        const newStatus = action === 'approve' ? 'approved' : 'rejected';
        await db.execute('UPDATE users SET kyc_status = ?, updated_at = NOW() WHERE id = ?', [newStatus, userId]);
        const [user] = await db.execute('SELECT username FROM users WHERE id = ?', [userId]);
        await telegramBot.notifyAdminAction(`KYC ${action === 'approve' ? 'Approved' : 'Rejected'}`, { admin: req.session.user.username, targetUser: user[0].username });
        req.flash('success', `KYC ${action === 'approve' ? 'approved' : 'rejected'} for ${user[0].username}`);
    } catch (error) {
        req.flash('error', error.message);
    }
    res.redirect('/admin');
});

router.post('/generate-withdraw-code/:id', ensureAdmin, async (req, res) => {
    try {
        const userId = req.params.id;
        const code = generateCode();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await db.execute(
            'UPDATE users SET withdrawal_code = ?, withdrawal_code_expires = ?, updated_at = NOW() WHERE id = ?',
            [code, expiresAt, userId]
        );
        const [user] = await db.execute('SELECT username, email FROM users WHERE id = ?', [userId]);
     
        // telegramBot → notifies ADMIN that a code was generated (private admin notification only)
        await telegramBot.notifyAdminAction('Withdraw Code Generated', { 
            admin: req.session.user.username, 
            targetUser: user[0].username, 
            code 
        });

        // Send withdrawal code to user's email
        try {
            await emailService.sendEmail({
                to: user[0].email,
                subject: '...',
                html: emailTemplate({
                    badge: '...',
                    badgeColor: '#22c55e',
                    username: user[0].username,
                    intro: '...',
                    amountDisplay: '...',
                    amountColor: '#22c55e',
                    rows: [],
                    footerNote: '...',
                    siteName: await getSiteName()
                })
            });     
        } catch (emailErr) { 
            console.error('Failed to send withdrawal code email:', emailErr); 
        }
        
        if (req.xhr) return res.json({ success: true, code });
        req.flash('success', `Code generated: ${code} and sent to ${user[0].email}`);
        res.redirect('/admin');
    } catch (error) {
        if (req.xhr) return res.status(500).json({ error: error.message });
        req.flash('error', error.message);
        res.redirect('/admin');
    }
});

router.post('/fund/:id', ensureAdmin, async (req, res) => {
    const conn = await db.getConnection();
    try {
        const userId = req.params.id;
        const amount = parseFloat(req.body.amount);
        const reason = req.body.reason || 'Admin credit';

        await conn.beginTransaction();
        await conn.execute('UPDATE users SET balance = balance + ?, updated_at = NOW() WHERE id = ?', [amount, userId]);
        await conn.execute(
            'INSERT INTO user_funding_logs (user_id, admin_id, type, amount, reason) VALUES (?, ?, ?, ?, ?)',
            [userId, req.session.user.id, 'credit', amount, reason]
        );
        await conn.commit();

        const [user] = await db.execute('SELECT username, email, balance FROM users WHERE id = ?', [userId]);

        await telegramBot.notifyAdminAction('Account Funded', { 
            admin: req.session.user.username, 
            targetUser: user[0].username, 
            amount 
        });

        // Get site name for email
        const siteName = await getSiteName();

        try {
            await emailService.sendEmail({
                to: user[0].email,
                subject: `Credit Alert — Your ${siteName} Account Has Been Funded`,
                html: emailTemplate({
                    badge: 'CREDIT ALERT', 
                    badgeColor: '#22c55e',
                    username: user[0].username,
                    intro: 'your trading account has been credited successfully.',
                    amountDisplay: `+$${parseFloat(amount).toFixed(2)}`, 
                    amountColor: '#22c55e',
                    rows: [
                        ['Transaction Type', 'Credit', '#22c55e'],
                        ['Reason', reason, '#f4f4f5'],
                        ['New Balance', `$${parseFloat(user[0].balance).toFixed(2)}`, '#22c55e'],
                        ['Date & Time', new Date().toUTCString(), '#f4f4f5'],
                    ],
                    footerNote: 'If you did not authorise this transaction, contact our support team immediately.',
                    siteName: siteName  // ← Pass site name here
                })
            });
        } catch (emailErr) { 
            console.error('Failed to send credit email:', emailErr); 
        }

        req.flash('success', `Credited $${amount} to ${user[0].username} — email sent`);
    } catch (error) {
        await conn.rollback();
        req.flash('error', error.message);
    } finally {
        conn.release();
        res.redirect('/admin');
    }
});

router.post('/deduct/:id', ensureAdmin, async (req, res) => {
    const conn = await db.getConnection();
    try {
        const userId = req.params.id;
        const amount = parseFloat(req.body.amount);
        const reason = req.body.reason || 'Admin debit';

        await conn.beginTransaction();
        const [users] = await conn.execute('SELECT balance, username, email FROM users WHERE id = ? FOR UPDATE', [userId]);
        if (users[0].balance < amount) throw new Error('Insufficient balance');

        await conn.execute('UPDATE users SET balance = balance - ?, updated_at = NOW() WHERE id = ?', [amount, userId]);
        await conn.execute(
            'INSERT INTO user_funding_logs (user_id, admin_id, type, amount, reason) VALUES (?, ?, ?, ?, ?)',
            [userId, req.session.user.id, 'debit', amount, reason]
        );
        await conn.commit();

        const newBalance = parseFloat(users[0].balance) - amount;

        await telegramBot.notifyAdminAction('Account Debited', { admin: req.session.user.username, targetUser: users[0].username, amount });

        try {
            await emailService.sendEmail({
                to: users[0].email,
                subject: `Debit Alert — Your ${res.locals.site.name} Account Has Been Debited`,
                html: emailTemplate({
                    badge: 'DEBIT ALERT', badgeColor: '#ef4444',
                    username: users[0].username,
                    intro: 'a debit transaction has been processed on your account.',
                    amountDisplay: `-$${parseFloat(amount).toFixed(2)}`, amountColor: '#ef4444',
                    rows: [
                        ['Transaction Type',  'Debit',                    '#ef4444'],
                        ['Reason',            reason,                     '#f4f4f5'],
                        ['Remaining Balance', `$${newBalance.toFixed(2)}`, '#f4f4f5'],
                        ['Date & Time',       new Date().toUTCString(),    '#f4f4f5'],
                    ],
                    footerNote: 'If you believe this is an error, please contact our support team immediately.'
                })
            });
        } catch (emailErr) { console.error('Failed to send debit email:', emailErr); }

        req.flash('success', `Deducted $${amount} from ${users[0].username} — email sent`);
    } catch (error) {
        await conn.rollback();
        req.flash('error', error.message);
    } finally {
        conn.release();
        res.redirect('/admin');
    }
});

router.post('/suspend/:id', ensureAdmin, async (req, res) => {
    try {
        const userId = req.params.id;
        const { action } = req.body;
        if (parseInt(userId) === req.session.user.id) {
            req.flash('error', 'Cannot suspend yourself');
            return res.redirect('/admin');
        }
        await db.execute('UPDATE users SET suspended = ?, updated_at = NOW() WHERE id = ?', [action === 'suspend' ? 1 : 0, userId]);
        const [user] = await db.execute('SELECT username FROM users WHERE id = ?', [userId]);
        await telegramBot.notifyAdminAction(`User ${action === 'suspend' ? 'Suspended' : 'Unsuspended'}`, { admin: req.session.user.username, targetUser: user[0].username });
        req.flash('success', `${user[0].username} ${action === 'suspend' ? 'suspended' : 'unsuspended'}`);
    } catch (error) {
        req.flash('error', error.message);
    }
    res.redirect('/admin');
});

router.post('/delete/:id', ensureAdmin, async (req, res) => {
    try {
        const userId = req.params.id;
        if (parseInt(userId) === req.session.user.id) {
            req.flash('error', 'Cannot delete yourself');
            return res.redirect('/admin');
        }
        await db.execute('DELETE FROM users WHERE id = ?', [userId]);
        await telegramBot.notifyAdminAction('User Deleted', { admin: req.session.user.username, targetUserId: userId });
        req.flash('success', 'User deleted');
    } catch (error) {
        req.flash('error', error.message);
    }
    res.redirect('/admin');
});

router.post('/role/:id', ensureAdmin, async (req, res) => {
    try {
        const userId = req.params.id;
        const { role } = req.body;
        if (parseInt(userId) === req.session.user.id && role === 'user') {
            req.flash('error', 'Cannot remove your own admin role');
            return res.redirect('/admin');
        }
        await db.execute('UPDATE users SET role = ?, updated_at = NOW() WHERE id = ?', [role, userId]);
        await telegramBot.notifyAdminAction(`Role changed to ${role}`, { admin: req.session.user.username, targetUserId: userId });
        req.flash('success', 'Role updated');
    } catch (error) {
        req.flash('error', error.message);
    }
    res.redirect('/admin');
});

router.post('/block/:id', ensureAdmin, async (req, res) => {
    try {
        const userId = req.params.id;
        if (parseInt(userId) === req.session.user.id) return res.redirect('/admin');
        await db.execute('UPDATE users SET blocked = 1, updated_at = NOW() WHERE id = ?', [userId]);
        req.flash('success', 'User blocked');
    } catch (error) {
        req.flash('error', error.message);
    }
    res.redirect('/admin');
});

router.post('/unblock/:id', ensureAdmin, async (req, res) => {
    try {
        await db.execute('UPDATE users SET blocked = 0, updated_at = NOW() WHERE id = ?', [req.params.id]);
        req.flash('success', 'User unblocked');
    } catch (error) {
        req.flash('error', error.message);
    }
    res.redirect('/admin');
});


// ==================== TRADING MANAGEMENT ====================

router.post('/trading-mode/:id', ensureAdmin, async (req, res) => {
    try {
        const userId = req.params.id;
        const { mode } = req.body;
        await db.execute('UPDATE users SET trading_mode = ?, updated_at = NOW() WHERE id = ?', [mode, userId]);
        const [user] = await db.execute('SELECT username FROM users WHERE id = ?', [userId]);
        const labels = {
            'normal':      'Normal Trading',
            'force_loss':  'FORCE LOSS (All positions will close at loss)',
            'force_win':   'FORCE WIN (All positions will close at profit)'
        };
        await telegramBot.notifyAdminAction('Trading Mode Changed', { admin: req.session.user.username, targetUser: user[0].username, mode: labels[mode] });
        req.flash('success', `${user[0].username}: ${labels[mode]}`);
    } catch (error) {
        req.flash('error', error.message);
    }
    res.redirect('/admin');
});


// ==================== TRADING SIGNALS ====================

router.post('/signal/create', ensureAdmin, async (req, res) => {
    try {
        const { pair, direction, entryPrice, targetPrice, stopLoss, leverage } = req.body;
        const [result] = await db.execute(`
            INSERT INTO trading_signals
            (admin_id, pair, direction, entry_price, target_price, stop_loss, leverage)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [req.session.user.id, pair.toUpperCase(), direction, entryPrice, targetPrice, stopLoss, leverage || 1]);

        const signalId = result.insertId;

        // signalBot → broadcasts signal TO CLIENTS
        const messageId = await signalBot.sendSignal({
            id: signalId, pair: pair.toUpperCase(), direction,
            entry_price: entryPrice, target_price: targetPrice,
            stop_loss: stopLoss, leverage: leverage || 1
        });

        if (messageId) {
            await db.execute('UPDATE trading_signals SET telegram_message_id = ? WHERE id = ?', [messageId, signalId]);
        }

        // telegramBot → notifies ADMIN that signal was created
        await telegramBot.notifyAdminAction('Signal Created', { admin: req.session.user.username, signalId, pair: pair.toUpperCase() });
        await logSystemEvent('success', `Signal #${signalId} created`, { pair, direction });
        req.flash('success', `Signal #${signalId} created${messageId ? ' and broadcast to clients' : ' (signal bot not configured)'}`);
    } catch (error) {
        req.flash('error', error.message);
    }
    res.redirect('/admin');
});

router.post('/signal/close/:id', ensureAdmin, async (req, res) => {
    try {
        const signalId = req.params.id;
        const { result } = req.body;
        const [signals] = await db.execute('SELECT pair, telegram_message_id FROM trading_signals WHERE id = ?', [signalId]);
        await db.execute(`UPDATE trading_signals SET status = 'completed', result = ?, completed_at = NOW() WHERE id = ?`, [result, signalId]);
        // signalBot → updates result in client channel
        await signalBot.updateSignalResult(signalId, result, signals[0]?.pair);
        req.flash('success', `Signal #${signalId} closed as ${result.toUpperCase()}`);
    } catch (error) {
        req.flash('error', error.message);
    }
    res.redirect('/admin');
});


// ==================== WALLET & NETWORK MANAGEMENT ====================

// GET /admin/wallets — Wallet management page
router.get('/wallets', ensureAdmin, async (req, res) => {
    try {
        const [wallets] = await db.execute(`
            SELECT w.*, n.name as network_name, n.symbol as network_symbol, n.is_active as network_active
            FROM wallet_addresses w
            JOIN networks n ON w.network_id = n.id
            ORDER BY n.sort_order ASC, w.created_at DESC
        `);

        const [networks] = await db.execute(`
            SELECT * FROM networks ORDER BY sort_order ASC, name ASC
        `);

        const walletsByNetwork = {};
        networks.forEach(network => {
            walletsByNetwork[network.id] = {
                network,
                wallets: wallets.filter(w => w.network_id === network.id)
            };
        });

        const [depositStats] = await db.execute(`
            SELECT
                w.id as wallet_id,
                w.address,
                n.name as network_name,
                COUNT(t.id) as total_deposits,
                COALESCE(SUM(CASE WHEN t.status = 'completed' THEN t.amount ELSE 0 END), 0) as total_received
            FROM wallet_addresses w
            JOIN networks n ON w.network_id = n.id
            LEFT JOIN transactions t ON t.wallet_address_id = w.id AND t.type = 'deposit'
            WHERE w.is_active = TRUE
            GROUP BY w.id
            ORDER BY total_received DESC
        `);

        // Get unread count for navbar
        const unreadCount = await getUnreadCount();

        res.render('admin/wallets', {
            title: 'Wallet & Network Management',
            walletsByNetwork,
            networks,
            depositStats,
            currentUser: req.session.user,
            unreadCount
        });
    } catch (error) {
        console.error('Wallet management error:', error);
        req.flash('error', 'Failed to load wallet management: ' + error.message);
        res.redirect('/admin');
    }
});

// POST /admin/wallets/network/create — Add new network
router.post('/wallets/network/create', ensureAdmin, async (req, res) => {
    const conn = await db.getConnection();
    try {
        const { name, symbol, chain_id, rpc_url, explorer_url, confirmation_blocks, sort_order } = req.body;

        await conn.beginTransaction();

        const [existing] = await conn.execute(
            'SELECT id FROM networks WHERE symbol = ? OR name = ?',
            [symbol.toUpperCase(), name]
        );
        if (existing.length > 0) throw new Error('Network with this name or symbol already exists');

        await conn.execute(`
            INSERT INTO networks
            (name, symbol, chain_id, rpc_url, explorer_url, confirmation_blocks, sort_order, is_active, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, NOW())
        `, [
            name, symbol.toUpperCase(),
            chain_id || null, rpc_url || null, explorer_url || null,
            confirmation_blocks || 12, sort_order || 0
        ]);

        await conn.commit();

        await telegramBot.notifyAdminAction('Network Added', { admin: req.session.user.username, network: name, symbol: symbol.toUpperCase() });
        req.flash('success', `Network "${name}" (${symbol.toUpperCase()}) added successfully`);
    } catch (error) {
        await conn.rollback();
        req.flash('error', error.message);
    } finally {
        conn.release();
        res.redirect('/admin/wallets');
    }
});

// POST /admin/wallets/network/:id/update — Update network
router.post('/wallets/network/:id/update', ensureAdmin, async (req, res) => {
    try {
        const { name, symbol, chain_id, rpc_url, explorer_url, confirmation_blocks, sort_order, is_active } = req.body;

        await db.execute(`
            UPDATE networks SET
                name = ?, symbol = ?, chain_id = ?, rpc_url = ?, explorer_url = ?,
                confirmation_blocks = ?, sort_order = ?, is_active = ?, updated_at = NOW()
            WHERE id = ?
        `, [
            name, symbol.toUpperCase(),
            chain_id || null, rpc_url || null, explorer_url || null,
            confirmation_blocks || 12, sort_order || 0,
            is_active === 'on' || is_active === '1' ? 1 : 0,
            req.params.id
        ]);

        await telegramBot.notifyAdminAction('Network Updated', { admin: req.session.user.username, network: name, symbol: symbol.toUpperCase() });
        req.flash('success', `Network "${name}" updated successfully`);
    } catch (error) {
        req.flash('error', error.message);
    }
    res.redirect('/admin/wallets');
});

// POST /admin/wallets/network/:id/toggle — Toggle network active status
router.post('/wallets/network/:id/toggle', ensureAdmin, async (req, res) => {
    try {
        const [networks] = await db.execute('SELECT * FROM networks WHERE id = ?', [req.params.id]);
        if (!networks.length) {
            req.flash('error', 'Network not found');
            return res.redirect('/admin/wallets');
        }
        const newStatus = !networks[0].is_active;
        await db.execute('UPDATE networks SET is_active = ?, updated_at = NOW() WHERE id = ?', [newStatus, req.params.id]);
        req.flash('success', `Network "${networks[0].name}" ${newStatus ? 'activated' : 'deactivated'}`);
    } catch (error) {
        req.flash('error', error.message);
    }
    res.redirect('/admin/wallets');
});

// POST /admin/wallets/address/create — Add new wallet address
router.post('/wallets/address/create', ensureAdmin, async (req, res) => {
    const conn = await db.getConnection();
    try {
        const { network_id, address, label, memo_tag, is_primary, daily_limit } = req.body;

        await conn.beginTransaction();

        const [networks] = await conn.execute('SELECT * FROM networks WHERE id = ? AND is_active = TRUE', [network_id]);
        if (!networks.length) throw new Error('Network not found or inactive');

        const [existing] = await conn.execute(
            'SELECT id FROM wallet_addresses WHERE address = ? AND network_id = ?',
            [address, network_id]
        );
        if (existing.length > 0) throw new Error('This wallet address already exists for this network');

        if (is_primary === 'on' || is_primary === '1') {
            await conn.execute('UPDATE wallet_addresses SET is_primary = FALSE WHERE network_id = ?', [network_id]);
        }

        await conn.execute(`
            INSERT INTO wallet_addresses
            (network_id, address, label, memo_tag, is_primary, is_active, daily_limit, current_daily_total, created_at)
            VALUES (?, ?, ?, ?, ?, TRUE, ?, 0, NOW())
        `, [
            network_id, address,
            label || null, memo_tag || null,
            is_primary === 'on' || is_primary === '1' ? 1 : 0,
            daily_limit || null
        ]);

        await conn.commit();

        await telegramBot.notifyAdminAction('Wallet Address Added', {
            admin:   req.session.user.username,
            network: networks[0].name,
            label:   label || 'Unlabeled',
            address: address.substring(0, 10) + '...' + address.slice(-6)
        });
        req.flash('success', `Wallet address added for ${networks[0].name}`);
    } catch (error) {
        await conn.rollback();
        req.flash('error', error.message);
    } finally {
        conn.release();
        res.redirect('/admin/wallets');
    }
});

// POST /admin/wallets/address/:id/update — Update wallet address
router.post('/wallets/address/:id/update', ensureAdmin, async (req, res) => {
    const conn = await db.getConnection();
    try {
        const { label, memo_tag, is_primary, is_active, daily_limit } = req.body;

        await conn.beginTransaction();

        const [wallets] = await conn.execute('SELECT * FROM wallet_addresses WHERE id = ?', [req.params.id]);
        if (!wallets.length) throw new Error('Wallet address not found');

        if ((is_primary === 'on' || is_primary === '1') && !wallets[0].is_primary) {
            await conn.execute(
                'UPDATE wallet_addresses SET is_primary = FALSE WHERE network_id = ? AND id != ?',
                [wallets[0].network_id, req.params.id]
            );
        }

        await conn.execute(`
            UPDATE wallet_addresses SET
                label = ?, memo_tag = ?, is_primary = ?, is_active = ?, daily_limit = ?, updated_at = NOW()
            WHERE id = ?
        `, [
            label || null, memo_tag || null,
            is_primary === 'on' || is_primary === '1' ? 1 : 0,
            is_active  === 'on' || is_active  === '1' ? 1 : 0,
            daily_limit || null,
            req.params.id
        ]);

        await conn.commit();

        await telegramBot.notifyAdminAction('Wallet Address Updated', { admin: req.session.user.username, label: label || 'Unlabeled' });
        req.flash('success', 'Wallet address updated successfully');
    } catch (error) {
        await conn.rollback();
        req.flash('error', error.message);
    } finally {
        conn.release();
        res.redirect('/admin/wallets');
    }
});

// POST /admin/wallets/address/:id/rotate — Rotate wallet address
router.post('/wallets/address/:id/rotate', ensureAdmin, async (req, res) => {
    const conn = await db.getConnection();
    try {
        const { new_address, reason } = req.body;

        await conn.beginTransaction();

        const [oldWallets] = await conn.execute(`
            SELECT w.*, n.name as network_name
            FROM wallet_addresses w
            JOIN networks n ON w.network_id = n.id
            WHERE w.id = ?
        `, [req.params.id]);
        if (!oldWallets.length) throw new Error('Wallet address not found');

        const oldWallet = oldWallets[0];

        await conn.execute(`
            UPDATE wallet_addresses
            SET is_active = FALSE, rotated_at = NOW(), rotated_reason = ?, replaced_by_address = ?
            WHERE id = ?
        `, [reason || 'Administrative rotation', new_address, req.params.id]);

        await conn.execute(`
            INSERT INTO wallet_addresses
            (network_id, address, label, is_primary, is_active, created_at, previous_address_id)
            VALUES (?, ?, ?, ?, TRUE, NOW(), ?)
        `, [
            oldWallet.network_id, new_address,
            oldWallet.label ? `${oldWallet.label} (Rotated)` : 'Rotated Address',
            oldWallet.is_primary, req.params.id
        ]);

        await conn.commit();

        await telegramBot.notifyAdminAction('Wallet Address Rotated', {
            admin:       req.session.user.username,
            network:     oldWallet.network_name,
            old_address: oldWallet.address.substring(0, 10) + '...',
            new_address: new_address.substring(0, 10) + '...'
        });
        req.flash('success', 'Wallet address rotated successfully. Old address deactivated, new address activated.');
    } catch (error) {
        await conn.rollback();
        req.flash('error', error.message);
    } finally {
        conn.release();
        res.redirect('/admin/wallets');
    }
});

// GET /admin/wallets/address/:id/history — Wallet transaction history (JSON)
router.get('/wallets/address/:id/history', ensureAdmin, async (req, res) => {
    try {
        const [wallet] = await db.execute(`
            SELECT w.*, n.name as network_name, n.symbol as network_symbol, n.explorer_url
            FROM wallet_addresses w
            JOIN networks n ON w.network_id = n.id
            WHERE w.id = ?
        `, [req.params.id]);

        if (!wallet.length) return res.status(404).json({ error: 'Wallet not found' });

        const [transactions] = await db.execute(`
            SELECT t.*, u.username, u.email
            FROM transactions t
            JOIN users u ON t.user_id = u.id
            WHERE t.wallet_address_id = ? AND t.type = 'deposit'
            ORDER BY t.created_at DESC
            LIMIT 50
        `, [req.params.id]);

        res.json({ wallet: wallet[0], transactions });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// ==================== CRYPTO WALLET MANAGEMENT ====================

// GET /admin/crypto-wallets — Manage crypto payment addresses
router.get('/crypto-wallets', ensureAdmin, async (req, res) => {
    try {
        const [addresses] = await db.execute(`
            SELECT * FROM crypto_payment_addresses 
            ORDER BY symbol ASC, is_active DESC, created_at DESC
        `);

        const walletsByCrypto = {};
        addresses.forEach(addr => {
            if (!walletsByCrypto[addr.symbol]) {
                walletsByCrypto[addr.symbol] = [];
            }
            walletsByCrypto[addr.symbol].push(addr);
        });

        const uniqueSymbols = [...new Set(addresses.map(a => a.symbol))];

        const [depositStats] = await db.execute(`
            SELECT 
                external_id as crypto_type,
                COUNT(*) as total_deposits,
                SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END) as total_received,
                SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END) as pending_amount
            FROM transactions 
            WHERE type = 'deposit' AND payment_method = 'crypto'
            GROUP BY external_id
        `);

        // Get unread count for navbar
        const unreadCount = await getUnreadCount();

        res.render('admin/crypto-wallets', {
            title: 'Crypto Wallet Management',
            walletsByCrypto,
            uniqueSymbols,
            depositStats,
            currentUser: req.session.user,
            unreadCount
        });
    } catch (error) {
        console.error('Crypto wallet management error:', error);
        req.flash('error', 'Failed to load wallet management: ' + error.message);
        res.redirect('/admin');
    }
});

// POST /admin/crypto-wallets/add — Add new crypto wallet address
router.post('/crypto-wallets/add', ensureAdmin, async (req, res) => {
    try {
        const { symbol, address, network, qr_code } = req.body;

        if (!symbol || !address) {
            req.flash('error', 'Cryptocurrency symbol and address are required');
            return res.redirect('/admin/crypto-wallets');
        }

        const [existing] = await db.execute(
            'SELECT id FROM crypto_payment_addresses WHERE address = ? AND symbol = ?',
            [address, symbol.toUpperCase()]
        );
        if (existing.length > 0) {
            req.flash('error', 'This address already exists for ' + symbol.toUpperCase());
            return res.redirect('/admin/crypto-wallets');
        }

        await db.execute(`
            INSERT INTO crypto_payment_addresses (symbol, address, network, qr_code, is_active, created_at) 
            VALUES (?, ?, ?, ?, TRUE, NOW())
        `, [symbol.toUpperCase(), address, network || 'Mainnet', qr_code || null]);

        await telegramBot.notifyAdminAction('Crypto Wallet Added', {
            admin:   req.session.user.username,
            symbol:  symbol.toUpperCase(),
            address: address.substring(0, 10) + '...' + address.slice(-6)
        });

        req.flash('success', `Wallet address added for ${symbol.toUpperCase()}`);
    } catch (error) {
        req.flash('error', error.message);
    }
    res.redirect('/admin/crypto-wallets');
});

// POST /admin/crypto-wallets/:id/update — Update crypto wallet address
router.post('/crypto-wallets/:id/update', ensureAdmin, async (req, res) => {
    try {
        const { address, network, qr_code, is_active } = req.body;

        const [wallets] = await db.execute(
            'SELECT * FROM crypto_payment_addresses WHERE id = ?',
            [req.params.id]
        );
        if (wallets.length === 0) {
            req.flash('error', 'Wallet address not found');
            return res.redirect('/admin/crypto-wallets');
        }

        await db.execute(`
            UPDATE crypto_payment_addresses 
            SET address = ?, network = ?, qr_code = ?, is_active = ?, updated_at = NOW()
            WHERE id = ?
        `, [
            address  || wallets[0].address,
            network  || wallets[0].network,
            qr_code  || wallets[0].qr_code,
            is_active === 'on' || is_active === '1' ? 1 : 0,
            req.params.id
        ]);

        req.flash('success', 'Wallet address updated successfully');
    } catch (error) {
        req.flash('error', error.message);
    }
    res.redirect('/admin/crypto-wallets');
});

// POST /admin/crypto-wallets/:id/delete — Delete crypto wallet address
router.post('/crypto-wallets/:id/delete', ensureAdmin, async (req, res) => {
    try {
        const [wallets] = await db.execute(
            'SELECT * FROM crypto_payment_addresses WHERE id = ?',
            [req.params.id]
        );
        if (wallets.length === 0) {
            req.flash('error', 'Wallet address not found');
            return res.redirect('/admin/crypto-wallets');
        }

        const [pendingTx] = await db.execute(`
            SELECT COUNT(*) as count FROM transactions 
            WHERE payment_method = 'crypto' AND external_id = ? AND status = 'pending'
        `, [wallets[0].symbol]);

        if (pendingTx[0].count > 0) {
            await db.execute(
                'UPDATE crypto_payment_addresses SET is_active = FALSE, updated_at = NOW() WHERE id = ?',
                [req.params.id]
            );
            req.flash('warning', `Address has ${pendingTx[0].count} pending deposits. Deactivated instead of deleted.`);
        } else {
            await db.execute('DELETE FROM crypto_payment_addresses WHERE id = ?', [req.params.id]);
            req.flash('success', 'Wallet address deleted successfully');
        }

        await telegramBot.notifyAdminAction('Crypto Wallet Deleted', {
            admin:   req.session.user.username,
            symbol:  wallets[0].symbol,
            address: wallets[0].address.substring(0, 10) + '...' + wallets[0].address.slice(-6)
        });
    } catch (error) {
        req.flash('error', error.message);
    }
    res.redirect('/admin/crypto-wallets');
});

// POST /admin/crypto-wallets/:id/toggle — Toggle crypto wallet active status
router.post('/crypto-wallets/:id/toggle', ensureAdmin, async (req, res) => {
    try {
        const [wallets] = await db.execute(
            'SELECT * FROM crypto_payment_addresses WHERE id = ?',
            [req.params.id]
        );
        if (wallets.length === 0) {
            req.flash('error', 'Wallet address not found');
            return res.redirect('/admin/crypto-wallets');
        }

        const newStatus = !wallets[0].is_active;
        await db.execute(
            'UPDATE crypto_payment_addresses SET is_active = ?, updated_at = NOW() WHERE id = ?',
            [newStatus, req.params.id]
        );

        req.flash('success', `Address ${newStatus ? 'activated' : 'deactivated'} for ${wallets[0].symbol}`);
    } catch (error) {
        req.flash('error', error.message);
    }
    res.redirect('/admin/crypto-wallets');
});


// ==================== TRANSACTION MANAGEMENT ====================

router.get('/withdrawals', ensureAdmin, async (req, res) => {
    try {
        const [withdrawals] = await db.execute(`
            SELECT t.*, u.username, u.email, u.balance as current_balance
            FROM transactions t
            JOIN users u ON t.user_id = u.id
            WHERE t.type = 'withdrawal'
            ORDER BY CASE t.status WHEN 'pending' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END, t.created_at DESC
        `);

        const [deposits] = await db.execute(`
            SELECT t.*, u.username, u.email, a.username as approved_by_username
            FROM transactions t
            JOIN users u ON t.user_id = u.id
            LEFT JOIN users a ON t.approved_by = a.id
            WHERE t.type = 'deposit'
            ORDER BY CASE t.status WHEN 'pending' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END, t.created_at DESC
        `);

        // Get unread count for navbar
        const unreadCount = await getUnreadCount();

        res.render('admin/withdrawals', {
            title: 'Transaction Management',
            withdrawals,
            deposits,
            currentUser: req.session.user,
            unreadCount
        });
    } catch (error) {
        console.error('Admin transactions error:', error);
        req.flash('error', 'Failed to load transactions');
        res.redirect('/admin');
    }
});

// GET /admin/withdrawals/:id - Transaction detail page
router.get('/withdrawals/:id', ensureAdmin, async (req, res) => {
    try {
        const [transactions] = await db.execute(`
            SELECT t.*, u.username, u.email, u.balance as current_balance,
                   u.phone, u.country, u.kyc_status, u.account_verified,
                   a.username as approved_by_username
            FROM transactions t
            JOIN users u ON t.user_id = u.id
            LEFT JOIN users a ON t.approved_by = a.id
            WHERE t.id = ?
        `, [req.params.id]);

        if (transactions.length === 0) {
            req.flash('error', 'Transaction not found');
            return res.redirect('/admin/withdrawals');
        }

        const transaction = transactions[0];

        // Get user's full transaction history
        const [userHistory] = await db.execute(`
            SELECT * FROM transactions
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT 10
        `, [transaction.user_id]);

        // Get unread count for navbar
        const unreadCount = await getUnreadCount();

        res.render('admin/transaction_detail', {
            title: 'Transaction Detail',
            transaction,
            userHistory,
            currentUser: req.session.user,
            unreadCount
        });

    } catch (error) {
        console.error('Transaction detail error:', error);
        req.flash('error', 'Failed to load transaction: ' + error.message);
        res.redirect('/admin/withdrawals');
    }
});
// ── Deposits ───────────────────────────────────────────────────────────────

router.post('/deposits/approve/:id', ensureAdmin, async (req, res) => {
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [transactions] = await conn.execute(
            `SELECT t.*, u.email, u.username FROM transactions t JOIN users u ON t.user_id = u.id
             WHERE t.id = ? AND t.type = 'deposit' AND t.status = 'pending'`,
            [req.params.id]
        );
        if (transactions.length === 0) {
            await conn.rollback();
            req.flash('error', 'Deposit not found or already processed');
            return res.redirect('/admin/withdrawals');
        }

        const deposit = transactions[0];

        await conn.execute(`UPDATE users SET balance = balance + ? WHERE id = ?`, [deposit.amount, deposit.user_id]);
        await conn.execute(
            `UPDATE transactions SET status = 'completed', approved_by = ?, approved_at = NOW() WHERE id = ?`,
            [req.session.user.id, req.params.id]
        );
        await conn.execute(
            `UPDATE holdings SET type = 'investment' WHERE user_id = ? AND type = 'investment_pending'`,
            [deposit.user_id]
        );
        await conn.execute(
            `INSERT INTO system_logs (level, message, metadata) VALUES (?, ?, ?)`,
            ['success', `Deposit #${req.params.id} approved`, JSON.stringify({ admin_id: req.session.user.id, user_id: deposit.user_id, amount: deposit.amount })]
        );
        await conn.commit();

        try {
            await emailService.sendEmail({
                to: deposit.email,
                subject: `Deposit Approved — Funds Added to Your ${res.locals.site.name} Account`,
                html: emailTemplate({
                    badge: 'DEPOSIT APPROVED', badgeColor: '#22c55e',
                    username: deposit.username,
                    intro: 'your deposit has been reviewed and approved. Your funds are now live.',
                    amountDisplay: `+$${parseFloat(deposit.amount).toFixed(2)}`, amountColor: '#22c55e',
                    rows: [
                        ['Transaction Type', 'Deposit',                          '#22c55e'],
                        ['Payment Method',   deposit.payment_method || 'N/A',   '#f4f4f5'],
                        ['Status',           'Approved ✓',                       '#22c55e'],
                        ['Date & Time',      new Date().toUTCString(),           '#f4f4f5'],
                    ],
                    footerNote: `Your funds are now available. Thank you for trading with ${res.locals.site.name}.`
                })
            });
        } catch (emailErr) { console.error('Failed to send deposit approval email:', emailErr); }

        req.flash('success', `Deposit of $${deposit.amount} for ${deposit.username} approved`);
        res.redirect('/admin/withdrawals');
    } catch (error) {
        await conn.rollback();
        req.flash('error', 'Failed to approve deposit: ' + error.message);
        res.redirect('/admin/withdrawals');
    } finally {
        conn.release();
    }
});

router.post('/deposits/reject/:id', ensureAdmin, async (req, res) => {
    const conn = await db.getConnection();
    try {
        const { reason } = req.body;
        await conn.beginTransaction();

        const [transactions] = await conn.execute(
            `SELECT t.*, u.username, u.email FROM transactions t JOIN users u ON t.user_id = u.id
             WHERE t.id = ? AND t.type = 'deposit' AND t.status = 'pending'`,
            [req.params.id]
        );
        if (transactions.length === 0) {
            await conn.rollback();
            req.flash('error', 'Deposit not found or already processed');
            return res.redirect('/admin/withdrawals');
        }

        const deposit = transactions[0];
        const rejectionReason = reason || 'Rejected by admin';

        await conn.execute(
            `UPDATE transactions SET status = 'rejected', approved_by = ?, approved_at = NOW(), rejection_reason = ? WHERE id = ?`,
            [req.session.user.id, rejectionReason, req.params.id]
        );
        await conn.execute(
            `DELETE FROM holdings WHERE user_id = ? AND type = 'investment_pending'`,
            [deposit.user_id]
        );
        await conn.commit();

        try {
            await emailService.sendEmail({
                to: deposit.email,
                subject: `Deposit Update — Action Required on Your ${res.locals.site.name} Account`,
                html: emailTemplate({
                    badge: 'DEPOSIT NOT PROCESSED', badgeColor: '#ef4444',
                    username: deposit.username,
                    intro: 'unfortunately your deposit could not be processed at this time.',
                    amountDisplay: `$${parseFloat(deposit.amount).toFixed(2)}`, amountColor: '#ef4444',
                    rows: [
                        ['Transaction Type', 'Deposit',                          '#f4f4f5'],
                        ['Payment Method',   deposit.payment_method || 'N/A',   '#f4f4f5'],
                        ['Status',           'Not Approved ✗',                   '#ef4444'],
                        ['Reason',           rejectionReason,                    '#f4f4f5'],
                        ['Date & Time',      new Date().toUTCString(),           '#f4f4f5'],
                    ],
                    footerNote: 'Please contact our support team for assistance or to resubmit your deposit.'
                })
            });
        } catch (emailErr) { console.error('Failed to send deposit rejection email:', emailErr); }

        req.flash('success', `Deposit rejected for ${deposit.username}`);
        res.redirect('/admin/withdrawals');
    } catch (error) {
        await conn.rollback();
        req.flash('error', 'Failed to reject deposit: ' + error.message);
        res.redirect('/admin/withdrawals');
    } finally {
        conn.release();
    }
});

// ── Withdrawals ────────────────────────────────────────────────────────────

router.post('/withdrawals/approve/:id', ensureAdmin, async (req, res) => {
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [transactions] = await conn.execute(
            `SELECT t.*, u.email, u.username, u.balance FROM transactions t JOIN users u ON t.user_id = u.id
             WHERE t.id = ? AND t.type = 'withdrawal' AND t.status = 'pending'`,
            [req.params.id]
        );
        if (transactions.length === 0) {
            await conn.rollback();
            req.flash('error', 'Withdrawal not found or already processed');
            return res.redirect('/admin/withdrawals');
        }

        const withdrawal = transactions[0];

        await conn.execute(
            `UPDATE transactions SET status = 'approved', approved_by = ?, approved_at = NOW() WHERE id = ?`,
            [req.session.user.id, req.params.id]
        );
        await conn.commit();

        try {
            await emailService.sendEmail({
                to: withdrawal.email,
                subject: `Withdrawal Approved — ${res.locals.site.name}`,
                html: emailTemplate({
                    badge: 'WITHDRAWAL APPROVED', badgeColor: '#22c55e',
                    username: withdrawal.username,
                    intro: 'your withdrawal request has been approved and is being processed.',
                    amountDisplay: `$${parseFloat(withdrawal.amount).toFixed(2)}`, amountColor: '#22c55e',
                    rows: [
                        ['Transaction Type', 'Withdrawal',                         '#f4f4f5'],
                        ['Payment Method',   withdrawal.payment_method || 'N/A',  '#f4f4f5'],
                        ['Status',           'Approved ✓',                         '#22c55e'],
                        ['Wallet / Address', withdrawal.external_id || 'N/A',     '#f4f4f5'],
                        ['Date & Time',      new Date().toUTCString(),             '#f4f4f5'],
                    ],
                    footerNote: 'Processing times vary by payment method. Contact support if you have any questions.'
                })
            });
        } catch (emailErr) { console.error('Failed to send withdrawal approval email:', emailErr); }

        await telegramBot.notifyAdminAction('Withdrawal Approved', { admin: req.session.user.username, targetUser: withdrawal.username, amount: withdrawal.amount });

        req.flash('success', `Withdrawal of $${withdrawal.amount} for ${withdrawal.username} approved`);
        res.redirect('/admin/withdrawals');
    } catch (error) {
        await conn.rollback();
        req.flash('error', 'Failed to approve withdrawal: ' + error.message);
        res.redirect('/admin/withdrawals');
    } finally {
        conn.release();
    }
});

router.post('/withdrawals/reject/:id', ensureAdmin, async (req, res) => {
    const conn = await db.getConnection();
    try {
        const { reason } = req.body;
        await conn.beginTransaction();

        const [transactions] = await conn.execute(
            `SELECT t.*, u.email, u.username, u.balance FROM transactions t JOIN users u ON t.user_id = u.id
             WHERE t.id = ? AND t.type = 'withdrawal' AND t.status = 'pending'`,
            [req.params.id]
        );
        if (transactions.length === 0) {
            await conn.rollback();
            req.flash('error', 'Withdrawal not found or already processed');
            return res.redirect('/admin/withdrawals');
        }

        const withdrawal = transactions[0];
        const rejectionReason = reason || 'Rejected by admin';

        // Refund amount back to user balance
        await conn.execute(`UPDATE users SET balance = balance + ? WHERE id = ?`, [withdrawal.amount, withdrawal.user_id]);
        await conn.execute(
            `UPDATE transactions SET status = 'rejected', approved_by = ?, approved_at = NOW(), rejection_reason = ? WHERE id = ?`,
            [req.session.user.id, rejectionReason, req.params.id]
        );
        await conn.commit();

        try {
            await emailService.sendEmail({
                to: withdrawal.email,
                subject: `Withdrawal Update — ${res.locals.site.name}`,
                html: emailTemplate({
                    badge: 'WITHDRAWAL NOT PROCESSED', badgeColor: '#ef4444',
                    username: withdrawal.username,
                    intro: 'your withdrawal request could not be processed. Your funds have been returned.',
                    amountDisplay: `$${parseFloat(withdrawal.amount).toFixed(2)}`, amountColor: '#ef4444',
                    rows: [
                        ['Transaction Type', 'Withdrawal',                         '#f4f4f5'],
                        ['Payment Method',   withdrawal.payment_method || 'N/A',  '#f4f4f5'],
                        ['Status',           'Rejected ✗',                         '#ef4444'],
                        ['Reason',           rejectionReason,                      '#f4f4f5'],
                        ['Refund Status',    'Returned to account ✓',              '#22c55e'],
                        ['Date & Time',      new Date().toUTCString(),             '#f4f4f5'],
                    ],
                    footerNote: 'The full amount has been returned to your trading balance. Contact support if you need help.'
                })
            });
        } catch (emailErr) { console.error('Failed to send withdrawal rejection email:', emailErr); }

        await telegramBot.notifyAdminAction('Withdrawal Rejected', { admin: req.session.user.username, targetUser: withdrawal.username, amount: withdrawal.amount });

        req.flash('success', `Withdrawal rejected for ${withdrawal.username} — funds refunded`);
        res.redirect('/admin/withdrawals');
    } catch (error) {
        await conn.rollback();
        req.flash('error', 'Failed to reject withdrawal: ' + error.message);
        res.redirect('/admin/withdrawals');
    } finally {
        conn.release();
    }
});


// ==================== ADMIN SETTINGS ====================

// GET /admin/settings
router.get('/settings', ensureAdmin, async (req, res) => {
    try {
        const [admins] = await db.execute(
            'SELECT id, username, email, phone, country, created_at FROM users WHERE role = ?',
            ['admin']
        );

        const [settings] = await db.execute(
            'SELECT * FROM site_settings ORDER BY setting_key ASC'
        );

        // Convert to key-value object
        const siteSettings = {};
        settings.forEach(s => { siteSettings[s.setting_key] = s.setting_value; });

        // Get unread count for navbar
        const unreadCount = await getUnreadCount();

        res.render('admin/settings', {
            title: 'Admin Settings',
            currentUser: req.session.user,
            admins,
            siteSettings,
            unreadCount
        });
    } catch (error) {
        console.error('Settings error:', error);
        req.flash('error', 'Failed to load settings: ' + error.message);
        res.redirect('/admin');
    }
});

// POST /admin/settings/site - Update site settings
router.post('/settings/site', ensureAdmin, async (req, res) => {
    try {
        const {
            support_email, support_phone, support_whatsapp,
            live_chat_enabled, site_name, maintenance_mode,
            min_withdrawal, max_withdrawal, min_deposit
        } = req.body;

        const settingsToSave = {
            support_email:     support_email    || '',
            support_phone:     support_phone    || '',
            support_whatsapp:  support_whatsapp || '',
            live_chat_enabled: live_chat_enabled === 'on' ? '1' : '0',
            tawkto_id:         req.body.tawkto_id || '',
            site_name:         site_name        || 'Maximum',
            maintenance_mode:  maintenance_mode === 'on' ? '1' : '0',
            min_withdrawal:    min_withdrawal   || '10',
            max_withdrawal:    max_withdrawal   || '100000',
            min_deposit:       min_deposit      || '10',
        };

        for (const [key, value] of Object.entries(settingsToSave)) {
            await db.execute(`
                INSERT INTO site_settings (setting_key, setting_value)
                VALUES (?, ?)
                ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)
            `, [key, value]);
        }

        await telegramBot.notifyAdminAction('Site Settings Updated', {
            admin: req.session.user.username
        });
        clearSettingsCache();
        req.flash('success', 'Site settings updated successfully');
    } catch (error) {
        req.flash('error', 'Failed to update settings: ' + error.message);
    }
    res.redirect('/admin/settings');
});

// POST /admin/settings/change-password - Change admin password
router.post('/settings/change-password', ensureAdmin, async (req, res) => {
    try {
        const { current_password, new_password, confirm_password } = req.body;
        const userId = req.session.user.id;
        const bcrypt = require('bcryptjs');

        if (new_password !== confirm_password) {
            req.flash('error', 'New passwords do not match');
            return res.redirect('/admin/settings');
        }

        if (new_password.length < 8) {
            req.flash('error', 'Password must be at least 8 characters');
            return res.redirect('/admin/settings');
        }

        const [users] = await db.execute(
            'SELECT password FROM users WHERE id = ?', [userId]
        );

        const isMatch = await bcrypt.compare(current_password, users[0].password);
        if (!isMatch) {
            req.flash('error', 'Current password is incorrect');
            return res.redirect('/admin/settings');
        }

        const hashed = await bcrypt.hash(new_password, 12);
        await db.execute(
            'UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?',
            [hashed, userId]
        );

        await telegramBot.notifyAdminAction('Admin Password Changed', {
            admin: req.session.user.username
        });

        req.flash('success', 'Password changed successfully');
    } catch (error) {
        req.flash('error', 'Failed to change password: ' + error.message);
    }
    res.redirect('/admin/settings');
});

// POST /admin/settings/change-email - Change admin email
router.post('/settings/change-email', ensureAdmin, async (req, res) => {
    try {
        const { new_email, password } = req.body;
        const userId = req.session.user.id;
        const bcrypt = require('bcryptjs');

        const [users] = await db.execute(
            'SELECT password, email FROM users WHERE id = ?', [userId]
        );

        const isMatch = await bcrypt.compare(password, users[0].password);
        if (!isMatch) {
            req.flash('error', 'Password is incorrect');
            return res.redirect('/admin/settings');
        }

        // Check email not taken
        const [existing] = await db.execute(
            'SELECT id FROM users WHERE email = ? AND id != ?',
            [new_email, userId]
        );
        if (existing.length > 0) {
            req.flash('error', 'Email already in use');
            return res.redirect('/admin/settings');
        }

        await db.execute(
            'UPDATE users SET email = ?, updated_at = NOW() WHERE id = ?',
            [new_email, userId]
        );

        req.session.user.email = new_email;

        await telegramBot.notifyAdminAction('Admin Email Changed', {
            admin: req.session.user.username,
            old_email: users[0].email,
            new_email
        });

        req.flash('success', 'Email updated successfully');
    } catch (error) {
        req.flash('error', 'Failed to update email: ' + error.message);
    }
    res.redirect('/admin/settings');
});

// POST /admin/settings/change-username - Change admin username
router.post('/settings/change-username', ensureAdmin, async (req, res) => {
    try {
        const { new_username, password } = req.body;
        const userId = req.session.user.id;
        const bcrypt = require('bcryptjs');

        const [users] = await db.execute(
            'SELECT password FROM users WHERE id = ?', [userId]
        );

        const isMatch = await bcrypt.compare(password, users[0].password);
        if (!isMatch) {
            req.flash('error', 'Password is incorrect');
            return res.redirect('/admin/settings');
        }

        const [existing] = await db.execute(
            'SELECT id FROM users WHERE username = ? AND id != ?',
            [new_username, userId]
        );
        if (existing.length > 0) {
            req.flash('error', 'Username already taken');
            return res.redirect('/admin/settings');
        }

        await db.execute(
            'UPDATE users SET username = ?, updated_at = NOW() WHERE id = ?',
            [new_username, userId]
        );

        req.session.user.username = new_username;

        req.flash('success', 'Username updated successfully');
    } catch (error) {
        req.flash('error', 'Failed to update username: ' + error.message);
    }
    res.redirect('/admin/settings');
});


// ==================== MESSAGING SYSTEM ====================

// GET /admin/messages — Admin messaging dashboard
router.get('/messages', ensureAdmin, async (req, res) => {
    try {
        // Get all users with message counts
        const [users] = await db.execute(`
            SELECT 
                u.id, u.username, u.email, u.created_at,
                COUNT(CASE WHEN m.status = 'unread' AND m.is_from_admin = FALSE THEN 1 END) as unread_replies,
                COUNT(CASE WHEN m.is_from_admin = TRUE THEN 1 END) as total_sent,
                MAX(m.created_at) as last_message_date
            FROM users u
            LEFT JOIN user_messages m ON u.id = m.user_id
            WHERE u.role = 'user'
            GROUP BY u.id
            ORDER BY unread_replies DESC, last_message_date DESC
        `);

        // Get recent conversations
        const [conversations] = await db.execute(`
            SELECT 
                m.*,
                u.username, u.email,
                a.username as admin_username,
                (SELECT COUNT(*) FROM user_messages WHERE parent_id = m.id AND status = 'unread') as unread_count
            FROM user_messages m
            JOIN users u ON m.user_id = u.id
            JOIN users a ON m.admin_id = a.id
            WHERE m.parent_id IS NULL AND m.is_from_admin = TRUE
            ORDER BY m.created_at DESC
            LIMIT 50
        `);

        // Get unread count for navbar
        const unreadCount = await getUnreadCount();

        res.render('admin/messages', {
            title: 'User Messaging',
            users,
            conversations,
            currentUser: req.session.user,
            messageTypes: ['warning', 'pending', 'welcome', 'general'],
            unreadCount
        });
    } catch (error) {
        console.error('Messaging error:', error);
        req.flash('error', 'Failed to load messaging: ' + error.message);
        res.redirect('/admin');
    }
});

// GET /admin/messages/users/:userId — Get conversation with specific user
router.get('/messages/user/:userId', ensureAdmin, async (req, res) => {
    try {
        const userId = req.params.userId;

        // Get user info
        const [users] = await db.execute(
            'SELECT id, username, email, created_at FROM users WHERE id = ?',
            [userId]
        );

        if (users.length === 0) {
            req.flash('error', 'User not found');
            return res.redirect('/admin/messages');
        }

        // Get full conversation thread
        const [messages] = await db.execute(`
            SELECT 
                m.*,
                u.username as sender_name,
                CASE WHEN m.is_from_admin THEN a.username ELSE u.username END as display_name
            FROM user_messages m
            JOIN users u ON m.user_id = u.id
            JOIN users a ON m.admin_id = a.id
            WHERE m.user_id = ? OR m.parent_id IN (
                SELECT id FROM user_messages WHERE user_id = ? AND parent_id IS NULL
            )
            ORDER BY m.created_at ASC
        `, [userId, userId]);

        // Mark user replies as read
        await db.execute(`
            UPDATE user_messages 
            SET status = 'read' 
            WHERE user_id = ? AND is_from_admin = FALSE AND status = 'unread'
        `, [userId]);

        // Get unread count for navbar
        const unreadCount = await getUnreadCount();

        res.render('admin/conversation', {
            title: `Conversation with ${users[0].username}`,
            user: users[0],
            messages,
            currentUser: req.session.user,
            unreadCount
        });
    } catch (error) {
        console.error('Conversation error:', error);
        req.flash('error', 'Failed to load conversation: ' + error.message);
        res.redirect('/admin/messages');
    }
});

// POST /admin/messages/send — Send message to user
// POST /admin/messages/send — Send message to user
router.post('/messages/send', ensureAdmin, async (req, res) => {
    const conn = await db.getConnection();
    try {
        const { user_id, type, subject, message, parent_id } = req.body;

        await conn.beginTransaction();

        // Get site settings for name
        const [[siteSetting]] = await conn.execute(
            "SELECT setting_value FROM site_settings WHERE setting_key = 'site_name'"
        );
        const siteName = siteSetting?.setting_value || 'Maximum';

        // Insert message
        const [result] = await conn.execute(`
            INSERT INTO user_messages 
            (user_id, admin_id, type, subject, message, parent_id, is_from_admin, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, TRUE, 'unread', NOW())
        `, [user_id, req.session.user.id, type, subject, message, parent_id || null]);

        // Get user details
        const [users] = await conn.execute(
            'SELECT username, email FROM users WHERE id = ?',
            [user_id]
        );

        const user = users[0];
        const typeLabels = {
            'warning': 'Warning',
            'pending': 'Action Required',
            'welcome': 'Welcome',
            'general': 'New Message',
            'reply': 'Reply'
        };

        const typeColors = {
            'warning': '#ef4444',
            'pending': '#f59e0b',
            'welcome': '#22c55e',
            'general': '#8b5cf6',
            'reply': '#3b82f6'
        };

        // Send email notification
        try {
            await emailService.sendEmail({
                to: user.email,
                subject: `${typeLabels[type]} from ${siteName} — ${subject}`,
                html: emailTemplate({
                    badge: typeLabels[type],
                    badgeColor: typeColors[type],
                    username: user.username,
                    intro: message,
                    rows: [
                        ['From', 'Support Team', '#111827'],
                        ['Subject', subject, '#111827'],
                        ['Date', new Date().toLocaleString(), '#111827']
                    ],
                    footerNote: 'This message was sent from your trading account dashboard.',
                    siteName: siteName,
                    siteUrl: req.protocol + '://' + req.get('host')
                })
            });
        } catch (emailErr) {
            console.error('Failed to send message email:', emailErr);
        }

        // Notify admin via Telegram
        await telegramBot.notifyAdminAction('Message Sent to User', {
            admin: req.session.user.username,
            targetUser: user.username,
            type: typeLabels[type],
            subject: subject
        });

        await conn.commit();

        req.flash('success', `Message sent to ${user.username}`);
        res.redirect(`/admin/messages/user/${user_id}`);
    } catch (error) {
        await conn.rollback();
        console.error('Send message error:', error);
        req.flash('error', 'Failed to send message: ' + error.message);
        res.redirect('/admin/messages');
    } finally {
        conn.release();
    }
});

// POST /admin/messages/bulk-send — Send bulk message to multiple users
router.post('/messages/bulk-send', ensureAdmin, async (req, res) => {
    const conn = await db.getConnection();
    try {
        const { user_ids, type, subject, message } = req.body;
        const userIds = Array.isArray(user_ids) ? user_ids : [user_ids];

        await conn.beginTransaction();

        const typeLabels = {
            'warning': '⚠️ Warning',
            'pending': '⏳ Pending Action Required',
            'welcome': '👋 Welcome',
            'general': '📨 Message'
        };

        let sentCount = 0;

        for (const userId of userIds) {
            await conn.execute(`
                INSERT INTO user_messages 
                (user_id, admin_id, type, subject, message, is_from_admin, status, created_at)
                VALUES (?, ?, ?, ?, ?, TRUE, 'unread', NOW())
            `, [userId, req.session.user.id, type, subject, message]);
            sentCount++;
        }

        await conn.commit();

        // Notify admin
        await telegramBot.notifyAdminAction('Bulk Message Sent', {
            admin: req.session.user.username,
            recipientCount: sentCount,
            type: typeLabels[type],
            subject: subject
        });

                req.flash('success', `Message sent to ${sentCount} user(s)`);
        res.redirect('/admin/messages');
    } catch (error) {
        await conn.rollback();
        req.flash('error', 'Failed to send bulk message: ' + error.message);
        res.redirect('/admin/messages');
    } finally {
        conn.release();
    }
});

// GET /admin/messages/unread-count — Get unread reply count (for AJAX)
// GET /admin/messages/unread-count — Get unread count for admin
router.get('/admin/messages/unread-count', ensureAuthenticated, async (req, res) => {
    try {
        // Check if user is admin
        if (req.session.user.role !== 'admin') {
            return res.status(403).json({ error: 'Access denied' });
        }

        const [[{ count }]] = await db.execute(`
            SELECT COUNT(*) as count 
            FROM user_messages 
            WHERE is_from_admin = FALSE AND status = 'unread'
        `);

        res.json({ count });
    } catch (error) {
        console.error('Unread count error:', error);
        res.status(500).json({ error: 'Failed to get count' });
    }
});

// ==================== USER WARNINGS / ALERTS ====================

// POST /admin/warnings/send — Send warning alert to user
router.post('/warnings/send', ensureAdmin, async (req, res) => {
    const conn = await db.getConnection();
    try {
        const { user_id, type, title, message, action_text, action_url } = req.body;

        await conn.beginTransaction();

        await conn.execute(`
            INSERT INTO user_warnings 
            (user_id, admin_id, type, title, message, action_text, action_url, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
        `, [user_id, req.session.user.id, type || 'warning', title, message, action_text || 'View Details', action_url || '/messages']);

        // Get user info for notification
        const [users] = await conn.execute(
            'SELECT username, email FROM users WHERE id = ?',
            [user_id]
        );

        const user = users[0];

        // Send email notification
        try {
            const [[siteSetting]] = await conn.execute(
                "SELECT setting_value FROM site_settings WHERE setting_key = 'site_name'"
            );
            const siteName = siteSetting?.setting_value || 'Maximum';

            // Messages, Warnings - use new messageTemplate
                await emailService.sendEmail({
                    to: user.email,
                    subject: `Warning from ${siteName} — ${subject}`,
                    html: messageTemplate({  // ← New clean template
                        badge: 'Warning',
                        badgeColor: '#f59e0b',
                        username: user.username,
                        intro: `<strong>${subject}</strong><br><br>${message}`,
                        rows: [
                            ['From', 'Support Team', '#111827'],
                            ['Date', new Date().toLocaleString(), '#111827']
                        ],
                        footerNote: 'Please log in to your account to view and reply.',
                        siteName: siteName,
                        siteUrl: req.protocol + '://' + req.get('host'),
                        buttonText: 'Reply to Message',
                        buttonUrl: `/messages/${messageId}`
                    })
                });
        } catch (emailErr) {
            console.error('Failed to send warning email:', emailErr);
        }

        // Notify admin
        await telegramBot.notifyAdminAction('Warning Alert Sent', {
            admin: req.session.user.username,
            targetUser: user.username,
            title: title,
            type: type || 'warning'
        });

        await conn.commit();

        req.flash('success', `Warning sent to ${user.username}`);
        res.redirect(`/admin/messages/user/${user_id}`);
    } catch (error) {
        await conn.rollback();
        console.error('Send warning error:', error);
        req.flash('error', 'Failed to send warning: ' + error.message);
        res.redirect('/admin/messages');
    } finally {
        conn.release();
    }
});

// POST /admin/warnings/:id/remove — Admin removes/dismisses a warning
router.post('/warnings/:id/remove', ensureAdmin, async (req, res) => {
    try {
        const warningId = req.params.id;
        
        // Get warning info before deleting
        const [warnings] = await db.execute(
            'SELECT user_id FROM user_warnings WHERE id = ?',
            [warningId]
        );

        if (warnings.length === 0) {
            req.flash('error', 'Warning not found');
            return res.redirect('back');
        }

        // Delete the warning (or mark as resolved)
        await db.execute('DELETE FROM user_warnings WHERE id = ?', [warningId]);

        req.flash('success', 'Warning removed successfully');
        res.redirect('back');
    } catch (error) {
        console.error('Remove warning error:', error);
        req.flash('error', 'Failed to remove warning');
        res.redirect('back');
    }
});

// POST /admin/warnings/clear-all/:userId — Clear all warnings for user
router.post('/warnings/clear-all/:userId', ensureAdmin, async (req, res) => {
    try {
        const userId = req.params.userId;
        await db.execute('DELETE FROM user_warnings WHERE user_id = ?', [userId]);
        
        req.flash('success', 'All warnings cleared for user');
        res.redirect('back');
    } catch (error) {
        console.error('Clear warnings error:', error);
        req.flash('error', 'Failed to clear warnings');
        res.redirect('back');
    }
});


module.exports = router;