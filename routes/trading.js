const express = require('express');
const router = express.Router();
const { ensureAuthenticated } = require('../middleware/authMiddleware');
const db = require('../config/db');
const { formatCurrency } = require('../utils/currency');
const emailService = require('../services/emailService'); // add this

// GET /trading - Forex trading dashboard
router.get('/', ensureAuthenticated, async (req, res) => {
    try {
        const userId = req.session.user.id;

        const [users] = await db.execute(`
            SELECT balance, margin_balance, equity, used_margin, free_margin, 
                   margin_level_percent, leverage, currency 
            FROM users WHERE id = ?
        `, [userId]);

        const userData = users[0] || { balance: 0, currency: 'USD' };

        const [pairs] = await db.execute(`
            SELECT * FROM forex_pairs 
            WHERE is_active = TRUE 
            ORDER BY FIELD(symbol, 'EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'XAGUSD'), symbol
        `);

        const [openPositions] = await db.execute(`
            SELECT t.*, p.name as pair_name, p.pip_value
            FROM forex_trades t
            JOIN forex_pairs p ON t.pair_id = p.id
            WHERE t.user_id = ? AND t.status = 'open'
            ORDER BY t.opened_at DESC
        `, [userId]);

        let totalOpenPnL = 0;
        for (const pos of openPositions) {
            totalOpenPnL += parseFloat(pos.profit_loss || 0);
        }

        const [tradeHistory] = await db.execute(`
            SELECT t.*, p.name as pair_name
            FROM forex_trades t
            JOIN forex_pairs p ON t.pair_id = p.id
            WHERE t.user_id = ? AND t.status = 'closed'
            ORDER BY t.closed_at DESC
            LIMIT 20
        `, [userId]);

        const parsedPairs = pairs.map(p => ({
            ...p,
            bid: parseFloat(p.bid) || 0,
            ask: parseFloat(p.ask) || 0,
            spread: parseFloat(p.spread) || 0
        }));

        res.render('trading/forex', {
            title: 'Forex Trading - Maximum',
            user: req.session.user,
            account: {
                balance: parseFloat(userData.balance) || 0,
                equity: parseFloat(userData.equity) || parseFloat(userData.balance) || 0,
                usedMargin: parseFloat(userData.used_margin) || 0,
                freeMargin: parseFloat(userData.free_margin) || parseFloat(userData.balance) || 0,
                marginLevel: parseFloat(userData.margin_level_percent) || 0,
                currency: userData.currency || 'USD',
                totalOpenPnL: totalOpenPnL || 0
            },
            pairs: parsedPairs,
            openPositions: openPositions || [],
            tradeHistory: tradeHistory || [],
            formatCurrency: formatCurrency
        });

    } catch (error) {
        console.error('Forex trading page error:', error);
        res.status(500).render('error', {
            title: 'Error',
            message: 'Failed to load trading data: ' + error.message
        });
    }
});

// POST /trading/open-position
router.post('/open-position', ensureAuthenticated, async (req, res) => {
    const connection = await db.getConnection();

    try {
        const { pair_id, direction, lot_size, leverage, stop_loss, take_profit } = req.body;
        const userId = req.session.user.id;

        const lotSize = parseFloat(lot_size);
        if (!lotSize || lotSize < 0.01) {
            req.flash('error', 'Minimum lot size is 0.01');
            return res.redirect('/trading');
        }

        const lev = parseInt(leverage) || 100;
        if (lev > 500) {
            req.flash('error', 'Maximum leverage is 500:1');
            return res.redirect('/trading');
        }

        await connection.beginTransaction();

        const [pairs] = await connection.execute(
            'SELECT * FROM forex_pairs WHERE id = ? AND is_active = TRUE',
            [pair_id]
        );

        if (!pairs.length) {
            await connection.rollback();
            req.flash('error', 'Trading pair not found or inactive');
            return res.redirect('/trading');
        }

        const pair = pairs[0];
        const entryPrice = direction === 'buy' ? pair.ask : pair.bid;
        const contractValue = lotSize * 100000;
        const marginRequired = contractValue / lev;

        const [users] = await connection.execute(
            'SELECT free_margin, balance FROM users WHERE id = ? FOR UPDATE',
            [userId]
        );

        const freeMargin = parseFloat(users[0].free_margin) || parseFloat(users[0].balance);

        if (freeMargin < marginRequired) {
            await connection.rollback();
            req.flash('error', `Insufficient margin. Required: $${marginRequired.toFixed(2)}, Available: $${freeMargin.toFixed(2)}`);
            return res.redirect('/trading');
        }

        await connection.execute(`
            INSERT INTO forex_trades 
            (user_id, pair_id, pair_symbol, direction, entry_price, current_price,
             lot_size, volume_usd, leverage_used, margin_required, 
             stop_loss, take_profit, status, opened_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NOW())
        `, [
            userId, pair.id, pair.symbol, direction, entryPrice, entryPrice,
            lotSize, contractValue, lev, marginRequired,
            stop_loss || null, take_profit || null
        ]);

        await connection.execute(`
            UPDATE users 
            SET used_margin = used_margin + ?,
                free_margin = free_margin - ?,
                margin_balance = margin_balance + ?
            WHERE id = ?
        `, [marginRequired, marginRequired, marginRequired, userId]);

        await connection.commit();

        req.flash('success', `${direction.toUpperCase()} position opened: ${lotSize} lots ${pair.symbol} at ${entryPrice}`);
        res.redirect('/trading');

    } catch (error) {
        await connection.rollback();
        console.error('Open position error:', error);
        req.flash('error', 'Failed to open position: ' + error.message);
        res.redirect('/trading');
    } finally {
        connection.release();
    }
});

// POST /trading/close-position/:id
router.post('/close-position/:id', ensureAuthenticated, async (req, res) => {
    const connection = await db.getConnection();
    try {
        const tradeId = req.params.id;
        const userId = req.session.user.id;

        await connection.beginTransaction();

        // Get trade and verify ownership
        const [trades] = await connection.execute(
            'SELECT * FROM forex_trades WHERE id = ? AND user_id = ? AND status = "open"',
            [tradeId, userId]
        );

        if (!trades.length) {
            await connection.rollback();
            req.flash('error', 'Position not found or already closed');
            return res.redirect('/trading');
        }

        const trade = trades[0];

        // ✅ Get user's trading_mode — this is what was missing
        const [userRows] = await connection.execute(
            'SELECT trading_mode, balance, email, username FROM users WHERE id = ?',
            [userId]
        );
        const user = userRows[0];
        const tradingMode = user.trading_mode || 'normal';

        // Get current market price
        const [pairs] = await connection.execute(
            'SELECT bid, ask FROM forex_pairs WHERE symbol = ?',
            [trade.pair_symbol]
        );

        const currentPrice = trade.direction === 'buy' ? pairs[0].bid : pairs[0].ask;

        // Calculate real market P&L first
        const pipSize = trade.pair_symbol.includes('JPY') ? 0.01 : 0.0001;
        let pipsProfit;

        if (trade.direction === 'buy') {
            pipsProfit = (currentPrice - trade.entry_price) / pipSize;
        } else {
            pipsProfit = (trade.entry_price - currentPrice) / pipSize;
        }

        const pipValue = trade.lot_size * 10;
        let profitLoss = pipsProfit * pipValue;

        // ✅ FORCE WIN/LOSS OVERRIDE
        // If admin set force_win, make sure P&L is positive (minimum +$10)
        // If admin set force_loss, make sure P&L is negative (minimum -$10)
        if (tradingMode === 'force_win') {
            if (profitLoss <= 0) {
                // Flip to a realistic-looking win
                pipsProfit = Math.abs(pipsProfit) || (10 + Math.random() * 40);
                profitLoss = Math.abs(profitLoss) || (pipsProfit * pipValue);
            }
        } else if (tradingMode === 'force_loss') {
            if (profitLoss >= 0) {
                // Flip to a realistic-looking loss
                pipsProfit = -(Math.abs(pipsProfit) || (10 + Math.random() * 40));
                profitLoss = -(Math.abs(profitLoss) || (Math.abs(pipsProfit) * pipValue));
            }
            // Make sure loss doesn't exceed user's balance
            const maxLoss = parseFloat(user.balance) * 0.9;
            if (Math.abs(profitLoss) > maxLoss) {
                profitLoss = -maxLoss;
            }
        }

        // Close the trade
        await connection.execute(`
            UPDATE forex_trades 
            SET status = 'closed',
                exit_price = ?,
                current_price = ?,
                pips_profit = ?,
                profit_loss = ?,
                closed_at = NOW(),
                close_reason = 'manual'
            WHERE id = ?
        `, [currentPrice, currentPrice, pipsProfit, profitLoss, tradeId]);

        // Update user balance and margin
        await connection.execute(`
            UPDATE users 
            SET balance = balance + ?,
                free_margin = free_margin + ?,
                used_margin = used_margin - ?
            WHERE id = ?
        `, [profitLoss, trade.margin_required, trade.margin_required, userId]);

        await connection.commit();

        const pnlText = `${profitLoss > 0 ? '+' : ''}$${profitLoss.toFixed(2)}`;
        req.flash('success', `Position closed. P&L: ${pnlText}`);
        res.redirect('/trading');

    } catch (error) {
        await connection.rollback();
        console.error('Close position error:', error);
        req.flash('error', 'Failed to close position');
        res.redirect('/trading');
    } finally {
        connection.release();
    }
});

module.exports = router;