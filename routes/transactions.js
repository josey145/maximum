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

        res.render('dashboard/withdraw_verify', {
            title:           'Verify Withdrawal - Maximum',
            user:            req.session.user,
            balance:         user.balance,
            balanceFormatted: formatCurrency(parseFloat(user.balance || 0), displayCurrency),
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

        const displayCurrency = users[0].currency          || 'USD';
        const balCurrency     = users[0].balance_currency  || displayCurrency;
        const rawBalance      = parseFloat(users[0].balance || 0);

        const [cryptoOptions] = await db.execute(
            'SELECT DISTINCT symbol, network FROM crypto_payment_addresses WHERE is_active = TRUE ORDER BY symbol ASC'
        );

        res.render('dashboard/withdraw', {
            title:            'Withdraw Funds - Maximum',
            user:             req.session.user,
            balance:          rawBalance,
            balanceFormatted: formatCurrency(rawBalance, balCurrency),
            currency:         displayCurrency,
            balanceCurrency:  balCurrency,
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

        // ── Fetch user balance + currencies ──────────────────────────────
        const [users] = await conn.execute(
            'SELECT balance, currency, balance_currency, username, email FROM users WHERE id = ? FOR UPDATE',
            [userId]
        );

        const user           = users[0];
        const balCurrency    = user.balance_currency || user.currency || 'USD';
        const userBalance    = parseFloat(user.balance);

        // ── The form always submits USD amounts (plan limits / display in USD)
        //    Convert the USD withdraw amount → user's balance currency for deduction.
        let deductAmount = withdrawInput;           // amount to deduct from DB (in balCurrency)
        let usdAmount    = withdrawInput;           // amount stored in transactions table (always USD)

        if (balCurrency !== 'USD') {
            const rate = await resolveRate('USD', balCurrency);
            if (!rate) {
                await conn.rollback();
                req.flash('error', `Exchange rate from USD to ${balCurrency} not available. Please contact support.`);
                return res.redirect('/transactions/withdraw/form');
            }
            deductAmount = withdrawInput * rate;
        }

        // ── Balance check (compare in the same currency as stored) ───────
        if (userBalance < deductAmount) {
            await conn.rollback();
            req.flash('error', `Insufficient balance. Available: ${formatCurrency(userBalance, balCurrency)}`);
            return res.redirect('/transactions/withdraw/form');
        }

        // ── Deduct balance ────────────────────────────────────────────────
        await conn.execute(
            'UPDATE users SET balance = balance - ?, updated_at = NOW() WHERE id = ?',
            [deductAmount, userId]
        );

        // ── Create transaction record (amount stored in USD, currency field = balCurrency) ─
        const externalId = payment_method === 'crypto'
            ? `${crypto_type}:${wallet_address.trim()}`
            : wallet_address.trim();

        await conn.execute(`
            INSERT INTO transactions
            (user_id, type, amount, currency, status, payment_method, external_id, created_at)
            VALUES (?, 'withdrawal', ?, ?, 'pending', ?, ?, NOW())
        `, [userId, usdAmount, balCurrency, payment_method, externalId]);

        await conn.commit();

        // ── Clear session ─────────────────────────────────────────────────
        delete req.session.withdrawalVerified;
        delete req.session.withdrawalCode;

        req.flash('success',
            `Withdrawal request of ${formatCurrency(deductAmount, balCurrency)} submitted successfully. Pending admin approval.`
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


module.exports = router;