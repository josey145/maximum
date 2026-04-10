const express = require('express');
const router = express.Router();
const { ensureAuthenticated } = require('../middleware/authMiddleware');
const db = require('../config/db');

// GET /trading - Trading page
router.get('/', ensureAuthenticated, async (req, res) => {
    try {
        const userId = req.session.user.id;
        
        // Get user balance
        const [users] = await db.execute(
            'SELECT balance, currency FROM users WHERE id = ?',
            [userId]
        );
        
        const userData = users[0] || { balance: 0, currency: 'USD' };
        
        // Get holdings
        const [holdings] = await db.execute(
            'SELECT symbol, amount, avg_buy_price, current_price FROM holdings WHERE user_id = ?',
            [userId]
        );
        
        // Get recent trades
        const [trades] = await db.execute(
            `SELECT symbol, type, amount, price, total, status, created_at 
             FROM trades 
             WHERE user_id = ? 
             ORDER BY created_at DESC 
             LIMIT 10`,
            [userId]
        );
        
        res.render('trading/trading', {
            title: 'Trading - Maximum',
            user: req.session.user,
            balance: parseFloat(userData.balance) || 0,
            currency: userData.currency || 'USD',
            holdings: holdings || [],
            trades: trades || []
        });
        
    } catch (error) {
        console.error('Trading page error:', error);
        res.render('trading/trading', {
            title: 'Trading - Maximum',
            user: req.session.user,
            balance: 0,
            currency: 'USD',
            holdings: [],
            trades: [],
            error: 'Failed to load trading data'
        });
    }
});

// POST /trading/buy - Fixed route path
router.post('/buy', ensureAuthenticated, async (req, res) => {
    const connection = await db.getConnection();
    
    try {
        const { amount, symbol, price } = req.body;
        const userId = req.session.user.id;
        
        console.log('Buy request:', { amount, symbol, price, userId });  // DEBUG
        
        // Validation
        if (!amount || isNaN(amount) || amount <= 0) {
            req.flash('error', 'Invalid amount');
            return res.redirect('/trading');
        }
        
        if (!symbol || !price) {
            req.flash('error', 'Missing symbol or price');
            return res.redirect('/trading');
        }
        
        const buyAmount = parseFloat(amount);
        const buyPrice = parseFloat(price);
        const total = buyAmount * buyPrice;
        
        await connection.beginTransaction();
        
        // Check balance
        const [users] = await connection.execute(
            'SELECT balance FROM users WHERE id = ? FOR UPDATE',
            [userId]
        );
        
        if (!users.length) {
            await connection.rollback();
            req.flash('error', 'User not found');
            return res.redirect('/trading');
        }
        
        const currentBalance = parseFloat(users[0].balance) || 0;
        
        if (currentBalance < total) {
            await connection.rollback();
            req.flash('error', `Insufficient balance. You have $${currentBalance.toFixed(2)}, need $${total.toFixed(2)}`);
            return res.redirect('/trading');
        }
        
        // Deduct balance
        await connection.execute(
            'UPDATE users SET balance = balance - ? WHERE id = ?',
            [total, userId]
        );
        
        // Update holdings
        await connection.execute(`
            INSERT INTO holdings (user_id, symbol, amount, avg_buy_price, current_price) 
            VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE 
            avg_buy_price = ((amount * avg_buy_price) + (? * ?)) / (amount + ?),
            amount = amount + ?,
            current_price = ?
        `, [userId, symbol, buyAmount, buyPrice, buyPrice, buyAmount, buyPrice, buyAmount, buyAmount, buyPrice]);
        
        // Record trade
        await connection.execute(
            `INSERT INTO trades (user_id, symbol, type, amount, price, status) 
             VALUES (?, ?, 'buy', ?, ?, 'completed')`,
            [userId, symbol, buyAmount, buyPrice]
        );
        
        await connection.commit();
        
        req.flash('success', `Bought ${buyAmount} ${symbol} for $${total.toFixed(2)}`);
        res.redirect('/trading');
        
    } catch (error) {
        await connection.rollback();
        console.error('Buy error:', error);
        req.flash('error', 'Buy failed: ' + error.message);
        res.redirect('/trading');
    } finally {
        connection.release();
    }
});

// POST /trading/sell - Fixed route path
router.post('/sell', ensureAuthenticated, async (req, res) => {
    const connection = await db.getConnection();
    
    try {
        const { amount, symbol, price } = req.body;
        const userId = req.session.user.id;
        
        console.log('Sell request:', { amount, symbol, price, userId });  // DEBUG
        
        if (!amount || isNaN(amount) || amount <= 0) {
            req.flash('error', 'Invalid amount');
            return res.redirect('/trading');
        }
        
        const sellAmount = parseFloat(amount);
        const sellPrice = parseFloat(price);
        const total = sellAmount * sellPrice;
        
        await connection.beginTransaction();
        
        // Check holdings
        const [holdings] = await connection.execute(
            'SELECT amount FROM holdings WHERE user_id = ? AND symbol = ? FOR UPDATE',
            [userId, symbol]
        );
        
        if (!holdings.length || parseFloat(holdings[0].amount) < sellAmount) {
            await connection.rollback();
            req.flash('error', `Insufficient ${symbol} holdings`);
            return res.redirect('/trading');
        }
        
        // Update holdings
        const newAmount = parseFloat(holdings[0].amount) - sellAmount;
        
        if (newAmount <= 0) {
            await connection.execute(
                'DELETE FROM holdings WHERE user_id = ? AND symbol = ?',
                [userId, symbol]
            );
        } else {
            await connection.execute(
                'UPDATE holdings SET amount = ? WHERE user_id = ? AND symbol = ?',
                [newAmount, userId, symbol]
            );
        }
        
        // Add to balance
        await connection.execute(
            'UPDATE users SET balance = balance + ? WHERE id = ?',
            [total, userId]
        );
        
        // Record trade
        await connection.execute(
            `INSERT INTO trades (user_id, symbol, type, amount, price, status) 
             VALUES (?, ?, 'sell', ?, ?, 'completed')`,
            [userId, symbol, sellAmount, sellPrice]
        );
        
        await connection.commit();
        
        req.flash('success', `Sold ${sellAmount} ${symbol} for $${total.toFixed(2)}`);
        res.redirect('/trading');
        
    } catch (error) {
        await connection.rollback();
        console.error('Sell error:', error);
        req.flash('error', 'Sell failed: ' + error.message);
        res.redirect('/trading');
    } finally {
        connection.release();
    }
});

module.exports = router;