const express = require('express');
const router = express.Router();
const { ensureAuthenticated } = require('../middleware/authMiddleware');
const db = require('../config/db');
const { formatCurrency, resolveRate } = require('../utils/currency'); // ← resolveRate added
const telegramBot = require('../services/telegramBot');

// ==================== GET /investments ====================

router.get('/', ensureAuthenticated, async (req, res) => {
    try {
        const userId         = req.session.user.id;
        const displayCurrency = req.session.user.currency || 'USD';

        const [users] = await db.execute(
            'SELECT balance, currency, balance_currency FROM users WHERE id = ?',
            [userId]
        );
        const user = users[0];

        const [plans] = await db.execute(`
            SELECT * FROM investment_plans
            WHERE is_active = TRUE
            ORDER BY min_amount ASC
        `);

        const [cryptoAddresses] = await db.execute(`
            SELECT * FROM crypto_payment_addresses WHERE is_active = TRUE
        `);

        const [investments] = await db.execute(`
            SELECT h.*, ip.name as plan_name, ip.color, ip.icon,
                   ip.daily_return_percent, ip.duration_days,
                   DATEDIFF(NOW(), h.created_at) as days_active
            FROM holdings h
            LEFT JOIN investment_plans ip ON h.plan_id = ip.id
            WHERE h.user_id = ? AND (h.type = 'investment' OR h.plan_id IS NOT NULL)
            ORDER BY h.created_at DESC
        `, [userId]);

        let totalInvested      = 0;
        let totalActiveEarnings = 0;
        let totalEarned        = 0;

        investments.forEach(inv => {
            const investedAmount = parseFloat(inv.amount) * parseFloat(inv.avg_buy_price || 1);
            const currentValue   = parseFloat(inv.amount) * parseFloat(inv.current_price || inv.avg_buy_price || 1);
            const profitLoss     = currentValue - investedAmount;

            inv.invested_amount   = investedAmount;
            inv.current_value     = currentValue;
            inv.profit_loss       = profitLoss;
            inv.daily_earning     = (investedAmount * parseFloat(inv.daily_return_percent || 0)) / 100;
            inv.expected_total    = inv.daily_earning * parseInt(inv.duration_days || 30);
            inv.progress_percent  = Math.min(
                (Math.abs(inv.days_active || 0) / parseInt(inv.duration_days || 30)) * 100,
                100
            );

            totalInvested       += investedAmount;
            totalActiveEarnings += inv.daily_earning;
            totalEarned         += profitLoss > 0 ? profitLoss : 0;
        });

        const [completedCount] = await db.execute(`
            SELECT COUNT(*) as count FROM holdings
            WHERE user_id = ?
              AND (type = 'investment' OR plan_id IS NOT NULL)
              AND DATEDIFF(NOW(), created_at) >= 30
        `, [userId]);

        res.render('investments/investments', {
            title:               'Investments & Trading - Maximum',
            user:                req.session.user,
            plans:               plans               || [],
            cryptoAddresses:     cryptoAddresses     || [],
            investments:         investments         || [],
            payouts:             [],
            totalInvested:       totalInvested       || 0,
            totalActiveEarnings: totalActiveEarnings || 0,
            totalEarned:         totalEarned         || 0,
            activeCount:         investments ? investments.length : 0,
            completedCount:      completedCount?.[0]?.count ?? 0,
            balanceFormatted:    formatCurrency(parseFloat(user.balance || 0), displayCurrency),
            formatCurrency
        });

    } catch (error) {
        console.error('Investments error:', error);
        res.render('investments/investments', {
            title:               'Investments & Trading - Maximum',
            user:                req.session.user,
            plans:               [],
            cryptoAddresses:     [],
            investments:         [],
            payouts:             [],
            totalInvested:       0,
            totalActiveEarnings: 0,
            totalEarned:         0,
            activeCount:         0,
            completedCount:      0,
            balanceFormatted:    formatCurrency(0, 'USD'),
            formatCurrency
        });
    }
});


// ==================== POST /investments/action ====================

router.post('/action', ensureAuthenticated, async (req, res) => {
    const conn = await db.getConnection();
    try {
        const { action_type, plan_id, amount, payment_method } = req.body;
        const crypto_type = req.body.crypto_type || null;
        const userId      = req.session.user.id;

        // ── Basic validation ──────────────────────────────────────────────
        if (!action_type) {
            req.flash('error', 'Action type is required');
            return res.redirect('/investments');
        }
        if (!amount || parseFloat(amount) <= 0) {
            req.flash('error', 'Valid amount is required');
            return res.redirect('/investments');
        }
        if (!payment_method) {
            req.flash('error', 'Payment method is required');
            return res.redirect('/investments');
        }

        const investAmount = parseFloat(amount);

        // ── Fetch user's active currency so we can convert if needed ──────
        const [userRows] = await db.execute(
            'SELECT balance, currency, balance_currency FROM users WHERE id = ?',
            [userId]
        );
        const currentUser    = userRows[0];
        const userCurrency   = currentUser.currency   || 'USD';
        const baseCurrency   = currentUser.balance_currency || userCurrency;

        /**
         * Convert the UI amount (always in USD since plan limits are in USD)
         * into the user's balance currency so we can check / deduct correctly.
         * If user is already in USD, rate = 1.
         */
        async function toUserCurrency(usdAmount) {
            if (baseCurrency === 'USD') return usdAmount;
            const rate = await resolveRate('USD', baseCurrency);
            if (!rate) {
                throw new Error(
                    `Exchange rate from USD to ${baseCurrency} not available. Please contact support.`
                );
            }
            return usdAmount * rate;
        }

        await conn.beginTransaction();

        // ══════════════════════════════════════════════════════════════════
        // FUND ACCOUNT
        // ══════════════════════════════════════════════════════════════════
        if (action_type === 'fund_account') {

            if (payment_method === 'balance') {
                await conn.rollback();
                req.flash('error', 'Cannot use balance to fund balance');
                return res.redirect('/investments');
            }

            // ── Crypto ──────────────────────────────────────────────────
            if (payment_method === 'crypto') {
                if (!crypto_type) {
                    await conn.rollback();
                    req.flash('error', 'Please select a cryptocurrency');
                    return res.redirect('/investments');
                }

                const [addresses] = await conn.execute(
                    'SELECT * FROM crypto_payment_addresses WHERE symbol = ? AND is_active = TRUE',
                    [crypto_type]
                );
                if (addresses.length === 0) {
                    await conn.rollback();
                    req.flash('error', 'Crypto payment not available for selected currency');
                    return res.redirect('/investments');
                }

                await conn.execute(`
                    INSERT INTO transactions
                    (user_id, type, amount, currency, status, payment_method, external_id, created_at)
                    VALUES (?, 'deposit', ?, 'USD', 'pending', 'crypto', ?, NOW())
                `, [userId, investAmount, crypto_type]);

                await conn.commit();

                return res.render('investments/crypto_payment', {
                    title:         'Complete Crypto Payment',
                    amount:        investAmount,
                    cryptoType:    crypto_type,
                    address:       addresses[0].address,
                    qrCode:        addresses[0].qr_code || null,
                    network:       addresses[0].network || 'Mainnet',
                    isInvestment:  false,
                    transactionId: null
                });
            }

            // ── Card ─────────────────────────────────────────────────────
            if (payment_method === 'card') {
                await conn.execute(`
                    INSERT INTO transactions
                    (user_id, type, amount, currency, status, payment_method, external_id, created_at)
                    VALUES (?, 'deposit', ?, 'USD', 'pending', 'card', 'card_pending', NOW())
                `, [userId, investAmount]);

                await conn.commit();

                req.flash('success', `Deposit of $${investAmount.toFixed(2)} submitted for approval. Your balance will be updated once approved by admin.`);
                return res.redirect('/investments');
            }

            await conn.rollback();
            req.flash('error', 'Invalid payment method');
            return res.redirect('/investments');
        }

        // ══════════════════════════════════════════════════════════════════
        // INVEST PLAN
        // ══════════════════════════════════════════════════════════════════
        else if (action_type === 'invest_plan') {

            if (!plan_id) {
                await conn.rollback();
                req.flash('error', 'Investment plan is required');
                return res.redirect('/investments');
            }

            const [plans] = await conn.execute(
                'SELECT * FROM investment_plans WHERE id = ? AND is_active = TRUE',
                [plan_id]
            );
            if (plans.length === 0) {
                await conn.rollback();
                req.flash('error', 'Investment plan not found');
                return res.redirect('/investments');
            }

            const plan = plans[0];

            if (investAmount < parseFloat(plan.min_amount) || investAmount > parseFloat(plan.max_amount)) {
                await conn.rollback();
                req.flash('error', `Amount must be between $${plan.min_amount} and $${plan.max_amount}`);
                return res.redirect('/investments');
            }

            // ── Crypto ──────────────────────────────────────────────────
            if (payment_method === 'crypto') {
                if (!crypto_type) {
                    await conn.rollback();
                    req.flash('error', 'Please select a cryptocurrency');
                    return res.redirect('/investments');
                }

                const [addresses] = await conn.execute(
                    'SELECT * FROM crypto_payment_addresses WHERE symbol = ? AND is_active = TRUE',
                    [crypto_type]
                );
                if (addresses.length === 0) {
                    await conn.rollback();
                    req.flash('error', 'Crypto payment not available');
                    return res.redirect('/investments');
                }

                await conn.execute(`
                    INSERT INTO holdings
                    (user_id, symbol, asset, amount, avg_buy_price, current_price, type, plan_id, created_at, updated_at)
                    VALUES (?, ?, ?, ?, 1, 1, 'investment_pending', ?, NOW(), NOW())
                `, [userId, plan.name, plan.name, investAmount, plan_id]);

                await conn.execute(`
                    INSERT INTO transactions
                    (user_id, type, amount, currency, status, payment_method, external_id, created_at)
                    VALUES (?, 'deposit', ?, 'USD', 'pending', 'crypto', ?, NOW())
                `, [userId, investAmount, crypto_type]);

                await conn.commit();

                return res.render('investments/crypto_payment', {
                    title:        'Complete Investment Payment',
                    amount:       investAmount,
                    cryptoType:   crypto_type,
                    address:      addresses[0].address,
                    qrCode:       addresses[0].qr_code || null,
                    network:      addresses[0].network || 'Mainnet',
                    isInvestment: true,
                    planName:     plan.name
                });
            }

            // ── Card ─────────────────────────────────────────────────────
            if (payment_method === 'card') {
                await conn.execute(`
                    INSERT INTO holdings
                    (user_id, symbol, asset, amount, avg_buy_price, current_price, type, plan_id, created_at, updated_at)
                    VALUES (?, ?, ?, ?, 1, 1, 'investment_pending', ?, NOW(), NOW())
                `, [userId, plan.name, plan.name, investAmount, plan_id]);

                await conn.execute(`
                    INSERT INTO transactions
                    (user_id, type, amount, currency, status, payment_method, external_id, created_at)
                    VALUES (?, 'deposit', ?, 'USD', 'pending', 'card', 'card_pending', NOW())
                `, [userId, investAmount]);

                await conn.commit();

                req.flash('success', `Investment of $${investAmount.toFixed(2)} in ${plan.name} submitted for approval.`);
                return res.redirect('/investments');
            }

            // ── Balance (instant) ────────────────────────────────────────
            if (payment_method === 'balance') {
                const [lockedUser] = await conn.execute(
                    'SELECT balance, currency, balance_currency FROM users WHERE id = ? FOR UPDATE',
                    [userId]
                );

                if (!lockedUser.length) {
                    await conn.rollback();
                    req.flash('error', 'User not found');
                    return res.redirect('/investments');
                }

                const userBalance    = parseFloat(lockedUser[0].balance);
                const userBalCurrency = lockedUser[0].balance_currency || lockedUser[0].currency || 'USD';

                // Convert USD invest amount into whatever currency the user's balance is stored in
                let deductAmount = investAmount;
                if (userBalCurrency !== 'USD') {
                    const rate = await resolveRate('USD', userBalCurrency);
                    if (!rate) {
                        await conn.rollback();
                        req.flash('error', `Exchange rate from USD to ${userBalCurrency} not available. Please contact support.`);
                        return res.redirect('/investments');
                    }
                    deductAmount = investAmount * rate;
                }

                if (userBalance < deductAmount) {
                    await conn.rollback();
                    req.flash('error', 'Insufficient balance');
                    return res.redirect('/investments');
                }

                await conn.execute(
                    'UPDATE users SET balance = balance - ? WHERE id = ?',
                    [deductAmount, userId]
                );

                await conn.execute(`
                    INSERT INTO holdings
                    (user_id, symbol, asset, amount, avg_buy_price, current_price, type, plan_id, created_at, updated_at)
                    VALUES (?, ?, ?, ?, 1, 1, 'investment', ?, NOW(), NOW())
                `, [userId, plan.name, plan.name, investAmount, plan_id]);

                await conn.execute(`
                    INSERT INTO transactions
                    (user_id, type, amount, currency, status, payment_method, created_at)
                    VALUES (?, 'deposit', ?, 'USD', 'completed', 'balance', NOW())
                `, [userId, investAmount]);

                await conn.commit();

                req.flash('success', `Successfully invested $${investAmount.toFixed(2)} in ${plan.name}!`);
                return res.redirect('/investments');
            }
        }

        // Invalid action type
        await conn.rollback();
        req.flash('error', 'Invalid action type');
        res.redirect('/investments');

    } catch (error) {
        await conn.rollback();
        console.error('Investment action error:', error);
        req.flash('error', 'Transaction failed: ' + error.message);
        res.redirect('/investments');
    } finally {
        conn.release();
    }
});


// ==================== GET /investments/confirm-crypto ====================

router.get('/confirm-crypto', ensureAuthenticated, (req, res) => {
    res.render('investments/confirm_crypto', {
        title: 'Confirm Payment - Maximum',
        user:  req.session.user
    });
});


// ==================== POST /investments/confirm-crypto ====================

router.post('/confirm-crypto', ensureAuthenticated, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { amount, crypto_type, transaction_hash } = req.body;

        const [transactions] = await db.execute(`
            SELECT * FROM transactions
            WHERE user_id = ? AND type = 'deposit' AND status = 'pending' AND payment_method = 'crypto'
            ORDER BY created_at DESC LIMIT 1
        `, [userId]);

        if (transactions.length > 0 && transaction_hash) {
            await db.execute(
                'UPDATE transactions SET external_id = ? WHERE id = ?',
                [transaction_hash, transactions[0].id]
            );
        }

        const [users] = await db.execute(
            'SELECT username, email FROM users WHERE id = ?',
            [userId]
        );

        await telegramBot.notifyAdminAction('Crypto Payment Confirmed by Client', {
            user:    users[0].username,
            email:   users[0].email,
            amount:  `$${parseFloat(amount || 0).toFixed(2)}`,
            crypto:  crypto_type || 'Unknown',
            txHash:  transaction_hash || 'Not provided',
            message: '⚠️ Client has clicked "I Have Paid". Please verify and approve the deposit.'
        });

        req.flash('success', 'Payment confirmation received. Our team will verify and approve your deposit shortly.');
        res.redirect('/investments');

    } catch (error) {
        console.error('Confirm crypto error:', error);
        req.flash('error', 'Failed to confirm payment: ' + error.message);
        res.redirect('/investments');
    }
});


module.exports = router;