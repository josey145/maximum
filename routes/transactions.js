const express = require('express');
const router  = express.Router();
const { ensureAuthenticated } = require('../middleware/authMiddleware');
const db = require('../config/db');
const { formatCurrency, resolveRate } = require('../utils/currency');

// ==================== GET /transactions/withdraw/verify ====================

router.get('/withdraw/verify', ensureAuthenticated, async (req, res) => {
    try {
        const [users] = await db.execute(
            'SELECT withdrawal_code, withdrawal_code_expires, balance, currency, balance_currency FROM users WHERE id = ?',
            [req.session.user.id]
        );

        const user            = users[0];
        const now             = new Date();
        const codeExpires     = user.withdrawal_code_expires ? new Date(user.withdrawal_code_expires) : null;
        const hasValidCode    = !!(user.withdrawal_code && codeExpires && codeExpires > now);
        const displayCurrency = user.currency || 'USD';

        // Convert balance to display currency for showing user
        const displayBalance = await convertAmount(user.balance, 'USD', displayCurrency);

        res.render('dashboard/withdraw_verify', {
            title:           'Verify Withdrawal - Maximum',
            user:            req.session.user,
            balance:         user.balance,                    // Raw USD balance (for processing)
            displayBalance:  displayBalance,                  // Converted for display
            balanceFormatted: formatCurrency(displayBalance, displayCurrency),
            currency:        displayCurrency,
            hasValidCode,
            codeExpired:     !!(user.withdrawal_code_expires && !hasValidCode),
            messages: {
                error:   req.flash('error'),
                success: req.flash('success')
            }
        });

    } catch (error) {
        console.error('Withdraw verify error:', error);
        req.flash('error', 'Failed to load withdrawal page');
        res.redirect('/dashboard');
    }
});


// ==================== POST /transactions/withdraw/verify ====================

router.post('/withdraw/verify', ensureAuthenticated, async (req, res) => {
    try {
        const { withdrawal_code } = req.body;

        const [users] = await db.execute(
            'SELECT withdrawal_code, withdrawal_code_expires FROM users WHERE id = ?',
            [req.session.user.id]
        );

        const user        = users[0];
        const now         = new Date();
        const codeExpires = user.withdrawal_code_expires ? new Date(user.withdrawal_code_expires) : null;

        if (!user.withdrawal_code) {
            req.flash('error', 'No withdrawal code found. Please contact admin to generate one.');
            return res.redirect('/transactions/withdraw/verify');
        }

        if (codeExpires && codeExpires < now) {
            req.flash('error', 'Withdrawal code has expired. Please request a new one from admin.');
            return res.redirect('/transactions/withdraw/verify');
        }

        if (user.withdrawal_code !== withdrawal_code) {
            req.flash('error', 'Invalid withdrawal code. Please try again.');
            return res.redirect('/transactions/withdraw/verify');
        }

        req.session.withdrawalVerified = true;
        req.session.withdrawalCode     = withdrawal_code;
        req.flash('success', 'Code verified successfully');
        res.redirect('/transactions/withdraw/form');

    } catch (error) {
        console.error('Withdraw verify error:', error);
        req.flash('error', 'Verification failed');
        res.redirect('/transactions/withdraw/verify');
    }
});


// ==================== GET /transactions/withdraw/form ====================

router.get('/withdraw/form', ensureAuthenticated, async (req, res) => {
    if (!req.session.withdrawalVerified) {
        req.flash('error', 'Please verify your withdrawal code first');
        return res.redirect('/transactions/withdraw/verify');
    }

    try {
        const [users] = await db.execute(
            'SELECT balance, currency, balance_currency FROM users WHERE id = ?',
            [req.session.user.id]
        );

        const displayCurrency = users[0].currency || 'USD';
        const rawBalance      = parseFloat(users[0].balance || 0); // Always USD in DB

        // Convert USD balance to display currency for user
        const displayBalance = await convertAmount(rawBalance, 'USD', displayCurrency);

        const [cryptoOptions] = await db.execute(
            'SELECT DISTINCT symbol, network FROM crypto_payment_addresses WHERE is_active = TRUE ORDER BY symbol ASC'
        );

        res.render('dashboard/withdraw', {
            title:            'Withdraw Funds - Maximum',
            user:             req.session.user,
            balance:          rawBalance,                           // USD (for processing)
            displayBalance:   displayBalance,                       // Converted (for display)
            balanceFormatted: formatCurrency(displayBalance, displayCurrency),
            currency:         displayCurrency,                      // User's chosen currency
            cryptoOptions:    cryptoOptions || [],
            withdrawalCode:   req.session.withdrawalCode,
            messages: {
                error:   req.flash('error'),
                success: req.flash('success')
            }
        });

    } catch (error) {
        console.error('Withdraw form error:', error);
        req.flash('error', 'Failed to load withdrawal form');
        res.redirect('/dashboard');
    }
});


// ==================== POST /transactions/withdraw/submit ====================

router.post('/withdraw/submit', ensureAuthenticated, async (req, res) => {
    if (!req.session.withdrawalVerified) {
        req.flash('error', 'Please verify your withdrawal code first');
        return res.redirect('/transactions/withdraw/verify');
    }

    const conn = await db.getConnection();

    try {
        const { amount, payment_method, wallet_address, crypto_type } = req.body;
        const userId        = req.session.user.id;
        const withdrawInput = parseFloat(amount);

        // ── Basic validation ──────────────────────────────────────────────
        if (!withdrawInput || withdrawInput <= 0) {
            req.flash('error', 'Invalid amount');
            return res.redirect('/transactions/withdraw/form');
        }

        if (!payment_method) {
            req.flash('error', 'Please select a withdrawal method');
            return res.redirect('/transactions/withdraw/form');
        }

        if (!wallet_address || wallet_address.trim() === '') {
            req.flash('error', 'Account / wallet details are required');
            return res.redirect('/transactions/withdraw/form');
        }

        if (payment_method === 'crypto' && !crypto_type) {
            req.flash('error', 'Please specify a cryptocurrency');
            return res.redirect('/transactions/withdraw/form');
        }

        await conn.beginTransaction();

        // ── Fetch user balance (always USD in database) ─────────────────
        const [users] = await conn.execute(
            'SELECT balance, currency, balance_currency, username, email FROM users WHERE id = ? FOR UPDATE',
            [userId]
        );

        const user           = users[0];
        const displayCurrency = user.currency || 'USD';
        const userBalance    = parseFloat(user.balance); // Always USD

        // ── Convert user's input FROM display currency TO USD ──────────────
        // User enters amount in their chosen currency (e.g., 5650 PHP)
        // We convert to USD for database storage (e.g., 100 USD)
        const usdAmount = await convertAmount(withdrawInput, displayCurrency, 'USD');

        console.log(`💱 Withdrawal: ${withdrawInput} ${displayCurrency} = ${usdAmount} USD`);

        // ── Balance check (compare in USD) ─────────────────────────────────
        if (userBalance < usdAmount) {
            await conn.rollback();
            const availableDisplay = await convertAmount(userBalance, 'USD', displayCurrency);
            req.flash('error', `Insufficient balance. Available: ${formatCurrency(availableDisplay, displayCurrency)}`);
            return res.redirect('/transactions/withdraw/form');
        }

        // ── Deduct balance in USD ─────────────────────────────────────────
        await conn.execute(
            'UPDATE users SET balance = balance - ?, updated_at = NOW() WHERE id = ?',
            [usdAmount, userId]
        );

        // ── Create transaction record ────────────────────────────────────
        // Store: amount in USD, currency field shows user's display currency
        const externalId = payment_method === 'crypto'
            ? `${crypto_type}:${wallet_address.trim()}`
            : wallet_address.trim();

        await conn.execute(`
            INSERT INTO transactions
            (user_id, type, amount, currency, status, payment_method, external_id, created_at)
            VALUES (?, 'withdrawal', ?, ?, 'pending', ?, ?, NOW())
        `, [userId, usdAmount, displayCurrency, payment_method, externalId]);

        await conn.commit();

        // ── Clear session ─────────────────────────────────────────────────
        delete req.session.withdrawalVerified;
        delete req.session.withdrawalCode;

        req.flash('success',
            `Withdrawal request of ${formatCurrency(withdrawInput, displayCurrency)} submitted successfully. Pending admin approval.`
        );
        res.redirect('/dashboard');

    } catch (error) {
        await conn.rollback();
        console.error('Withdraw submit error:', error);
        req.flash('error', 'Withdrawal failed: ' + error.message);
        res.redirect('/transactions/withdraw/form');
    } finally {
        conn.release();
    }
});


// ==================== GET /transactions/history ====================

router.get('/history', ensureAuthenticated, async (req, res) => {
    try {
        const [transactions] = await db.execute(`
            SELECT * FROM transactions
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT 50
        `, [req.session.user.id]);

        const [users] = await db.execute(
            'SELECT currency, balance_currency FROM users WHERE id = ?',
            [req.session.user.id]
        );

        const displayCurrency = users[0]?.currency || 'USD';

        // Convert transaction amounts to display currency
        for (const t of transactions) {
            t.displayAmount = await convertAmount(t.amount, 'USD', displayCurrency);
        }

        res.render('dashboard/history', {
            title:           'Transaction History - Maximum',
            user:            req.session.user,
            transactions,
            displayCurrency,
            formatCurrency
        });

    } catch (error) {
        console.error('Transaction history error:', error);
        req.flash('error', 'Failed to load transaction history');
        res.redirect('/dashboard');
    }
});


// ==================== HELPER: Convert Amount ====================

async function convertAmount(amount, from, to) {
    if (!amount || isNaN(amount)) return 0;
    if (from === to) return parseFloat(amount);
    
    const rate = await resolveRate(from, to);
    return parseFloat(amount) * rate;
}


module.exports = router;