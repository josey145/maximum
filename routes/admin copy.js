const express = require('express');
const router = express.Router();
const { ensureAdmin } = require('../middleware/authMiddleware');
const db = require('../config/db');
const telegramBot = require('../services/telegramBot');
const signalBot = require('../services/signalBot');

// ==================== HELPERS ====================

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

        // Get pending withdrawals count for badge
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

        res.render('admin/dashboard', { 
            title: 'Admin Panel',
            users: users,
            currentUser: req.session.user,
            signals: signals || [],
            adminPositions: adminPositions || [],
            adminHistory: adminHistory || [],
            logs: logs || [],
            stats: stats || {},
            withdrawalStats: withdrawalStats || { total_pending: 0, pending_amount: 0 },
            signalBotConfigured: typeof signalBot !== 'undefined' ? signalBot.isConfigured() : false
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
        await telegramBot.notifyAdminAction('Account Verified', {
            admin: req.session.user.username,
            targetUser: user[0].username
        });
        
        req.flash('success', `Account verified for ${user[0].username}`);
        res.redirect('/admin');
    } catch (error) {
        req.flash('error', error.message);
        res.redirect('/admin');
    }
});

router.post('/verify-kyc/:id', ensureAdmin, async (req, res) => {
    try {
        const userId = req.params.id;
        const { action } = req.body;
        const newStatus = action === 'approve' ? 'approved' : 'rejected';
        
        await db.execute('UPDATE users SET kyc_status = ?, updated_at = NOW() WHERE id = ?', [newStatus, userId]);
        
        const [user] = await db.execute('SELECT username FROM users WHERE id = ?', [userId]);
        await telegramBot.notifyAdminAction(`KYC ${action === 'approve' ? 'Approved' : 'Rejected'}`, {
            admin: req.session.user.username,
            targetUser: user[0].username
        });
        
        req.flash('success', `KYC ${action === 'approve' ? 'approved' : 'rejected'} for ${user[0].username}`);
        res.redirect('/admin');
    } catch (error) {
        req.flash('error', error.message);
        res.redirect('/admin');
    }
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
        
        await signalBot.notifyWithdrawCode(user[0].username, code, expiresAt);
        await telegramBot.notifyAdminAction('Withdraw Code Generated', {
            admin: req.session.user.username,
            targetUser: user[0].username,
            code: code
        });
        
        if (req.xhr) return res.json({ success: true, code });
        
        req.flash('success', `Code generated: ${code}`);
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
        
        await conn.beginTransaction();
        await conn.execute('UPDATE users SET balance = balance + ?, updated_at = NOW() WHERE id = ?', [amount, userId]);
        await conn.execute(
            'INSERT INTO user_funding_logs (user_id, admin_id, type, amount, reason) VALUES (?, ?, ?, ?, ?)',
            [userId, req.session.user.id, 'credit', amount, req.body.reason || 'Admin credit']
        );
        await conn.commit();
        
        const [user] = await db.execute('SELECT username FROM users WHERE id = ?', [userId]);
        await telegramBot.notifyAdminAction('Account Funded', {
            admin: req.session.user.username,
            targetUser: user[0].username,
            amount
        });
        
        req.flash('success', `Credited $${amount} to ${user[0].username}`);
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
        
        await conn.beginTransaction();
        
        const [users] = await conn.execute('SELECT balance, username FROM users WHERE id = ? FOR UPDATE', [userId]);
        if (users[0].balance < amount) throw new Error('Insufficient balance');
        
        await conn.execute('UPDATE users SET balance = balance - ?, updated_at = NOW() WHERE id = ?', [amount, userId]);
        await conn.execute(
            'INSERT INTO user_funding_logs (user_id, admin_id, type, amount, reason) VALUES (?, ?, ?, ?, ?)',
            [userId, req.session.user.id, 'debit', amount, req.body.reason]
        );
        await conn.commit();
        
        await telegramBot.notifyAdminAction('Account Debited', {
            admin: req.session.user.username,
            targetUser: users[0].username,
            amount
        });
        
        req.flash('success', `Deducted $${amount} from ${users[0].username}`);
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
        await telegramBot.notifyAdminAction(`User ${action === 'suspend' ? 'Suspended' : 'Unsuspended'}`, {
            admin: req.session.user.username,
            targetUser: user[0].username
        });
        
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
            'normal': 'Normal Trading',
            'force_loss': 'FORCE LOSS (All positions will close at loss)',
            'force_win': 'FORCE WIN (All positions will close at profit)'
        };
        
        await telegramBot.notifyAdminAction('Trading Mode Changed', {
            admin: req.session.user.username,
            targetUser: user[0].username,
            mode: labels[mode]
        });
        
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
        
        const messageId = await signalBot.sendSignal({
            id: signalId,
            pair: pair.toUpperCase(),
            direction,
            entry_price: entryPrice,
            target_price: targetPrice,
            stop_loss: stopLoss,
            leverage: leverage || 1
        });
        
        if (messageId) {
            await db.execute('UPDATE trading_signals SET telegram_message_id = ? WHERE id = ?', [messageId, signalId]);
        }
        
        await telegramBot.notifyAdminAction('Signal Created', {
            admin: req.session.user.username,
            signalId,
            pair: pair.toUpperCase()
        });
        
        await logSystemEvent('success', `Signal #${signalId} created`, { pair, direction });
        
        req.flash('success', `Signal #${signalId} created${messageId ? ' and broadcast' : ' (bot not configured)'}`);
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
        
        await signalBot.updateSignalResult(signalId, result, signals[0]?.pair);
        
        req.flash('success', `Signal #${signalId} closed as ${result.toUpperCase()}`);
    } catch (error) {
        req.flash('error', error.message);
    }
    res.redirect('/admin');
});

// ==================== WITHDRAWAL MANAGEMENT ====================

router.get('/withdrawals', ensureAdmin, async (req, res) => {
    try {
        const [withdrawals] = await db.execute(`
            SELECT 
                t.*,
                u.username,
                u.email,
                u.balance as current_balance
            FROM transactions t
            JOIN users u ON t.user_id = u.id
            WHERE t.type = 'withdrawal'
            ORDER BY 
                CASE t.status 
                    WHEN 'pending' THEN 1 
                    WHEN 'approved' THEN 2 
                    ELSE 3 
                END,
                t.created_at DESC
        `);

        res.render('admin/withdrawals', {
            title: 'Withdrawal Management',
            withdrawals: withdrawals,
            currentUser: req.session.user
        });
    } catch (error) {
        console.error('Withdrawals fetch error:', error);
        req.flash('error', 'Failed to load withdrawals');
        res.redirect('/admin');
    }
});

router.post('/withdrawals/approve/:id', ensureAdmin, async (req, res) => {
    const conn = await db.getConnection();
    try {
        const withdrawalId = req.params.id;
        const adminId = req.session.user.id;

        await conn.beginTransaction();

        const [withdrawals] = await conn.execute(
            `SELECT t.*, u.balance, u.username, u.email 
             FROM transactions t 
             JOIN users u ON t.user_id = u.id 
             WHERE t.id = ? AND t.type = 'withdrawal' AND t.status = 'pending'
             FOR UPDATE`,
            [withdrawalId]
        );

        if (withdrawals.length === 0) {
            await conn.rollback();
            req.flash('error', 'Withdrawal not found or already processed');
            return res.redirect('/admin/withdrawals');
        }

        const withdrawal = withdrawals[0];

        if (parseFloat(withdrawal.amount) > parseFloat(withdrawal.balance)) {
            await conn.rollback();
            
            await conn.execute(
                `UPDATE transactions 
                 SET status = 'rejected', 
                     rejection_reason = 'Insufficient balance at approval time',
                     updated_at = NOW() 
                 WHERE id = ?`,
                [withdrawalId]
            );
            
            await conn.commit();
            req.flash('error', `Withdrawal rejected: User ${withdrawal.username} has insufficient balance`);
            return res.redirect('/admin/withdrawals');
        }

        await conn.execute(
            `UPDATE transactions 
             SET status = 'approved', 
                 approved_by = ?, 
                 approved_at = NOW(),
                 updated_at = NOW() 
             WHERE id = ?`,
            [adminId, withdrawalId]
        );

        await conn.execute(
            `UPDATE users 
             SET balance = balance - ?, 
                 updated_at = NOW() 
             WHERE id = ?`,
            [withdrawal.amount, withdrawal.user_id]
        );

        await conn.execute(
            `INSERT INTO system_logs (level, message, metadata) 
             VALUES (?, ?, ?)`,
            ['success', 
             `Withdrawal #${withdrawalId} approved`, 
             JSON.stringify({
                 admin_id: adminId,
                 user_id: withdrawal.user_id,
                 amount: withdrawal.amount,
                 method: withdrawal.payment_method
             })]
        );

        await conn.commit();

        req.flash('success', `Withdrawal of $${withdrawal.amount} for ${withdrawal.username} approved`);
        res.redirect('/admin/withdrawals');

    } catch (error) {
        await conn.rollback();
        console.error('Withdrawal approval error:', error);
        req.flash('error', 'Failed to approve withdrawal: ' + error.message);
        res.redirect('/admin/withdrawals');
    } finally {
        conn.release();
    }
});

router.post('/withdrawals/reject/:id', ensureAdmin, async (req, res) => {
    const conn = await db.getConnection();
    try {
        const withdrawalId = req.params.id;
        const { reason } = req.body;
        const adminId = req.session.user.id;

        await conn.beginTransaction();

        const [withdrawals] = await conn.execute(
            `SELECT t.*, u.username, u.email 
             FROM transactions t 
             JOIN users u ON t.user_id = u.id 
             WHERE t.id = ? AND t.type = 'withdrawal' AND t.status = 'pending'`,
            [withdrawalId]
        );

        if (withdrawals.length === 0) {
            await conn.rollback();
            req.flash('error', 'Withdrawal not found or already processed');
            return res.redirect('/admin/withdrawals');
        }

        const withdrawal = withdrawals[0];

        await conn.execute(
            `UPDATE transactions 
             SET status = 'rejected', 
                 approved_by = ?,
                 rejection_reason = ?,
                 updated_at = NOW() 
             WHERE id = ?`,
            [adminId, reason || 'Rejected by admin', withdrawalId]
        );

        await conn.execute(
            `UPDATE users 
             SET balance = balance + ?, 
                 updated_at = NOW() 
             WHERE id = ?`,
            [withdrawal.amount, withdrawal.user_id]
        );

        await conn.execute(
            `INSERT INTO system_logs (level, message, metadata) 
             VALUES (?, ?, ?)`,
            ['warning', 
             `Withdrawal #${withdrawalId} rejected`, 
             JSON.stringify({
                 admin_id: adminId,
                 user_id: withdrawal.user_id,
                 amount: withdrawal.amount,
                 reason: reason
             })]
        );

        await conn.commit();

        req.flash('success', `Withdrawal rejected and $${withdrawal.amount} refunded to ${withdrawal.username}`);
        res.redirect('/admin/withdrawals');

    } catch (error) {
        await conn.rollback();
        console.error('Withdrawal rejection error:', error);
        req.flash('error', 'Failed to reject withdrawal: ' + error.message);
        res.redirect('/admin/withdrawals');
    } finally {
        conn.release();
    }
});

router.get('/withdrawals/:id', ensureAdmin, async (req, res) => {
    try {
        const [withdrawals] = await db.execute(`
            SELECT 
                t.*,
                u.username,
                u.email,
                u.phone,
                u.country,
                a.username as approved_by_username
            FROM transactions t
            JOIN users u ON t.user_id = u.id
            LEFT JOIN users a ON t.approved_by = a.id
            WHERE t.id = ? AND t.type = 'withdrawal'
        `, [req.params.id]);

        if (withdrawals.length === 0) {
            req.flash('error', 'Withdrawal not found');
            return res.redirect('/admin/withdrawals');
        }

        res.render('admin/withdrawal-detail', {
            title: 'Withdrawal Details',
            withdrawal: withdrawals[0]
        });
    } catch (error) {
        console.error('Withdrawal detail error:', error);
        req.flash('error', 'Failed to load withdrawal details');
        res.redirect('/admin/withdrawals');
    }
});

module.exports = router;