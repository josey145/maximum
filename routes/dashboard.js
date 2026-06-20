const express = require('express');
const router = express.Router();
const { ensureAuthenticated } = require('../middleware/authMiddleware');
const db = require('../config/db');
const { formatCurrency } = require('../utils/currency');

// Hardcoded rates fallback
const TEST_RATES = {
    'USD': { 'EUR': 0.92, 'GBP': 0.79, 'NGN': 1500, 'USD': 1, 'INR': 83.5, 'PKR': 278, 'BDT': 109.5, 'PHP': 56.5, 'AED': 3.67, 'SAR': 3.75, 'ZAR': 18.5, 'KES': 129, 'GHS': 12.5, 'XOF': 605, 'XAF': 605, 'EGP': 30.9, 'MAD': 10.1 },
    'EUR': { 'USD': 1.09, 'EUR': 1, 'INR': 90.5, 'NGN': 1635 },
    'GBP': { 'USD': 1.27, 'GBP': 1, 'INR': 105.2 },
    'NGN': { 'USD': 0.00067, 'NGN': 1, 'INR': 0.056 },
    'INR': { 'USD': 0.012, 'INR': 1, 'NGN': 17.9 },
    'PKR': { 'USD': 0.0036, 'PKR': 1 },
    'BDT': { 'USD': 0.0091, 'BDT': 1 },
    'PHP': { 'USD': 0.018, 'PHP': 1 },
    'AED': { 'USD': 0.27, 'AED': 1 },
    'SAR': { 'USD': 0.27, 'SAR': 1 },
    'ZAR': { 'USD': 0.054, 'ZAR': 1 },
    'KES': { 'USD': 0.0078, 'KES': 1 },
    'GHS': { 'USD': 0.08, 'GHS': 1 },
    'XOF': { 'USD': 0.00165, 'XOF': 1 },
    'XAF': { 'USD': 0.00165, 'XAF': 1 },
    'EGP': { 'USD': 0.032, 'EGP': 1 },
    'MAD': { 'USD': 0.099, 'MAD': 1 }
};

// Helper: Convert any amount from one currency to another
async function convertAmount(amount, fromCurrency, toCurrency) {
    if (!amount || isNaN(amount)) return 0;
    if (fromCurrency === toCurrency) return parseFloat(amount);
    
    const rate = await getRate(fromCurrency, toCurrency);
    return parseFloat(amount) * rate;
}

router.get('/', ensureAuthenticated, async (req, res) => {
    
    try {
        const userId = req.session.user?.id;
        
        if (!userId) {
            req.flash('error', 'Please login');
            return res.redirect('/login');
        }

        // Get FULL user data
        const [users] = await db.execute(`
            SELECT id, username, email, role, kyc_status, account_verified, 
                   currency, balance, balance_currency, country, phone, 
                   created_at, trading_mode, suspended
            FROM users 
            WHERE id = ?
        `, [userId]);
        
        if (!users.length) {
            req.flash('error', 'User not found');
            return res.redirect('/login');
        }
        
       const user = users[0];
        const displayCurrency = user.currency || 'USD';
        const baseCurrency = 'USD';

        // DEBUG - Now user is defined!
        console.log('🔍 User currency:', user.currency);
        console.log('🔍 Balance currency:', user.balance_currency);
        console.log('🔍 Base currency:', baseCurrency);
        console.log('🔍 Display currency:', displayCurrency);
        console.log('🔍 Are they same?', baseCurrency === displayCurrency);

        // Get exchange rate ONCE
        const exchangeRate = await getRate(baseCurrency, displayCurrency);
        console.log(`💱 Exchange rate: 1 ${baseCurrency} = ${exchangeRate} ${displayCurrency}`);

       
                
                    // Get user's holdings/investments with current prices
            const [holdings] = await db.execute(`
                SELECT h.*, 
                    COALESCE(h.current_price, 0) as price,
                    COALESCE(h.amount, 0) * COALESCE(h.current_price, 0) as value
                FROM holdings h 
                WHERE h.user_id = ?
            `, [userId]);
            
            // Calculate portfolio value - CONVERT each holding to display currency
            let totalValueBase = 0;
            for (const h of holdings) {
                const rawValue = parseFloat(h.value) || 0;
                const convertedValue = await convertAmount(rawValue, baseCurrency, displayCurrency);
                h.converted_value = convertedValue;
                totalValueBase += convertedValue;
            }

        // Get REAL trading stats from forex_trades
        const [tradeStats] = await db.execute(`
            SELECT 
                COUNT(*) as total_trades,
                SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_positions,
                SUM(CASE WHEN status = 'closed' AND profit_loss > 0 THEN 1 ELSE 0 END) as winning_trades,
                SUM(CASE WHEN status = 'closed' AND profit_loss < 0 THEN 1 ELSE 0 END) as losing_trades,
                SUM(CASE WHEN status = 'closed' THEN profit_loss ELSE 0 END) as total_pnl,
                SUM(CASE WHEN status = 'open' THEN profit_loss ELSE 0 END) as unrealized_pnl
            FROM forex_trades 
            WHERE user_id = ?
        `, [userId]);
        
        const stats = tradeStats[0] || {};
        
        // Convert trade stats to display currency
        const convertedTotalPnL = await convertAmount(stats.total_pnl, baseCurrency, displayCurrency);
        const convertedUnrealizedPnL = await convertAmount(stats.unrealized_pnl, baseCurrency, displayCurrency);

        // Get recent closed trades
        const [recentTrades] = await db.execute(`
            SELECT t.*, p.name as pair_name, p.symbol
            FROM forex_trades t
            LEFT JOIN forex_pairs p ON t.pair_id = p.id
            WHERE t.user_id = ? AND t.status = 'closed'
            ORDER BY t.closed_at DESC
            LIMIT 5
        `, [userId]);
        
        // Convert trade P&L for display
        for (const trade of recentTrades) {
            trade.converted_profit_loss = await convertAmount(trade.profit_loss, baseCurrency, displayCurrency);
        }
        
        // Get active/open trades
        const [activeInvestments] = await db.execute(`
            SELECT t.*, p.name as pair_name, p.symbol
            FROM forex_trades t
            LEFT JOIN forex_pairs p ON t.pair_id = p.id
            WHERE t.user_id = ? AND t.status = 'open'
            ORDER BY t.opened_at DESC
        `, [userId]);
        
        // Convert active investment values
        let activeInvestmentValue = 0;
        for (const trade of activeInvestments) {
            const margin = await convertAmount(trade.margin_required || 0, baseCurrency, displayCurrency);
            const pl = await convertAmount(trade.profit_loss || 0, baseCurrency, displayCurrency);
            
            trade.converted_margin = margin;
            trade.converted_profit_loss = pl;
            trade.converted_entry_price = await convertAmount(trade.entry_price || 0, baseCurrency, displayCurrency);
            
            activeInvestmentValue += (margin + pl);
        }

        // ============================================
        // GET TOTAL DEPOSITS - CONVERTED
        // ============================================
        const [deposits] = await db.execute(`
            SELECT amount, currency as txn_currency, status
            FROM transactions 
            WHERE user_id = ? AND type = 'deposit'
        `, [userId]);

        let totalDeposited = 0;
        let pendingDeposits = 0;
        let depositCount = 0;
        
        for (const d of deposits) {
            const txnCurrency = d.txn_currency || baseCurrency;
            const convertedAmount = await convertAmount(d.amount, txnCurrency, displayCurrency);
            
            if (d.status === 'completed' || d.status === 'approved') {
                totalDeposited += convertedAmount;
            } else if (d.status === 'pending') {
                pendingDeposits += convertedAmount;
            }
            depositCount++;
        }

        // Get total withdrawals - CONVERTED
        const [withdrawals] = await db.execute(`
            SELECT amount, currency as txn_currency, status
            FROM transactions 
            WHERE user_id = ? AND type = 'withdrawal'
        `, [userId]);

        let totalWithdrawn = 0;
        let withdrawalCount = 0;
        
        for (const w of withdrawals) {
            const txnCurrency = w.txn_currency || baseCurrency;
            const convertedAmount = await convertAmount(w.amount, txnCurrency, displayCurrency);
            
            if (w.status === 'completed' || w.status === 'approved') {
                totalWithdrawn += convertedAmount;
            }
            withdrawalCount++;
        }

        // Convert balance
        const displayBalance = await convertAmount(user.balance, baseCurrency, displayCurrency);

        // ============================================
        // GET WARNINGS FROM DATABASE
        // ============================================
        const [warnings] = await db.execute(`
            SELECT * FROM user_warnings 
            WHERE user_id = ? AND is_dismissed = 0
            ORDER BY created_at DESC
        `, [userId]);

        // Get unread messages count
        const [[{ unreadMessages }]] = await db.execute(`
            SELECT COUNT(*) as unreadMessages 
            FROM user_messages 
            WHERE user_id = ? AND status = 'unread' AND is_from_admin = TRUE
        `, [userId]);

        // Get latest unread message
        const [latestMessages] = await db.execute(`
            SELECT m.*, a.username as admin_username
            FROM user_messages m
            JOIN users a ON m.admin_id = a.id
            WHERE m.user_id = ? AND m.status = 'unread' AND m.is_from_admin = TRUE AND m.parent_id IS NULL
            ORDER BY m.created_at DESC
            LIMIT 1
        `, [userId]);

        // Add latest unread message as warning
        const latestMessage = latestMessages[0];
        if (latestMessage) {
            let msgType = 'general';
            if (latestMessage.type === 'warning' || latestMessage.priority === 'high') {
                msgType = 'warning';
            } else if (latestMessage.type === 'pending' || latestMessage.priority === 'medium') {
                msgType = 'pending';
            } else if (latestMessage.type === 'welcome') {
                msgType = 'welcome';
            }
            
            warnings.unshift({
                id: 'unread-message-' + latestMessage.id,
                type: msgType,
                title: latestMessage.subject || 'New Message from Admin',
                message: latestMessage.message.substring(0, 120) + (latestMessage.message.length > 120 ? '...' : ''),
                action_url: '/messages/' + latestMessage.id,
                action_text: 'Read Message'
            });
        }

        console.log('Final warnings count:', warnings.length);

        // Format for display - ALL in user's display currency
        const balanceFormatted = formatCurrency(displayBalance, displayCurrency);
        const totalValueFormatted = formatCurrency(totalValueBase, displayCurrency);
        const activeInvestmentFormatted = formatCurrency(activeInvestmentValue, displayCurrency);
        const totalPnLFormatted = formatCurrency(convertedTotalPnL, displayCurrency);
        const unrealizedPnLFormatted = formatCurrency(convertedUnrealizedPnL, displayCurrency);
        const totalDepositsFormatted = formatCurrency(totalDeposited, displayCurrency);
        const pendingDepositsFormatted = formatCurrency(pendingDeposits, displayCurrency);
        const totalWithdrawalsFormatted = formatCurrency(totalWithdrawn, displayCurrency);
        
        // Update session with fresh data
        req.session.user = {
            ...req.session.user,
            ...user,
            balance: user.balance,
            kyc_status: user.kyc_status,
            account_verified: user.account_verified
        };

        res.render('dashboard/dashboard', { 
            title: `Dashboard - ${displayCurrency}`,
            user: user,
            holdings: holdings,
            totalValue: totalValueBase,
            totalValueFormatted: totalValueFormatted,
            balanceFormatted: balanceFormatted,
            activeInvestmentFormatted: activeInvestmentFormatted,
            totalPnLFormatted: totalPnLFormatted,
            unrealizedPnLFormatted: unrealizedPnLFormatted,
            activeInvestments: activeInvestments,
            recentTrades: recentTrades,
            tradeStats: {
                totalTrades: stats.total_trades || 0,
                openPositions: stats.open_positions || 0,
                winningTrades: stats.winning_trades || 0,
                losingTrades: stats.losing_trades || 0,
                winRate: stats.total_trades > 0 
                    ? ((stats.winning_trades / stats.total_trades) * 100).toFixed(1) 
                    : 0
            },
            totalDepositsFormatted: totalDepositsFormatted,
            pendingDepositsFormatted: pendingDepositsFormatted,
            totalWithdrawalsFormatted: totalWithdrawalsFormatted,
            totalDepositsCount: depositCount,
            pendingDepositsCount: deposits.length > 0 ? 
                Math.round((pendingDeposits / totalDeposited) * 100) : 0,
            totalWithdrawalsCount: withdrawalCount,
            warnings: warnings,
            unreadMessages: unreadMessages || 0,
            displayCurrency: displayCurrency, // Pass to template
            formatCurrency: formatCurrency
        });
        
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).render('error', { 
            title: 'Error',
            message: 'Failed to load dashboard: ' + error.message 
        });
    }
});
// POST /dashboard/warnings/:id/dismiss
router.post('/warnings/:id/dismiss', ensureAuthenticated, async (req, res) => {
    try {
        const warningId = req.params.id;
        const userId = req.session.user.id;

        // Verify warning belongs to user
        const [warnings] = await db.execute(
            'SELECT * FROM user_warnings WHERE id = ? AND user_id = ?',
            [warningId, userId]
        );

        if (warnings.length === 0) {
            return res.status(404).json({ error: 'Warning not found' });
        }

        // Mark as dismissed
        await db.execute(`
            UPDATE user_warnings 
            SET is_dismissed = 1, dismissed_at = NOW() 
            WHERE id = ?
        `, [warningId]);

        res.json({ success: true });
    } catch (error) {
        console.error('Dismiss warning error:', error);
        res.status(500).json({ error: 'Failed to dismiss warning' });
    }
});

// Helper function to get exchange rate
async function getRate(from, to) {
    if (from === to) return 1;

    // 1) Try the database first (live/authoritative rates)
    try {
        const [rates] = await db.execute(
            'SELECT rate FROM exchange_rates WHERE from_currency = ? AND to_currency = ?',
            [from, to]
        );
        if (rates.length > 0) return parseFloat(rates[0].rate);
    } catch (e) {
        console.log('DB rate lookup failed:', e.message);
    }

    // 2) Fall back to hardcoded TEST_RATES (direct pair)
    if (TEST_RATES[from] && TEST_RATES[from][to] !== undefined) {
        console.log(`Using fallback TEST_RATES for ${from} -> ${to}`);
        return TEST_RATES[from][to];
    }

    // 3) Fall back to the inverse of a known pair
    if (TEST_RATES[to] && TEST_RATES[to][from] !== undefined && TEST_RATES[to][from] !== 0) {
        console.log(`Using inverse fallback TEST_RATES for ${from} -> ${to}`);
        return 1 / TEST_RATES[to][from];
    }

    // 4) Last resort: convert via USD as a bridge currency
    if (TEST_RATES[from] && TEST_RATES[from]['USD'] !== undefined &&
        TEST_RATES['USD'] && TEST_RATES['USD'][to] !== undefined) {
        const viaUsd = TEST_RATES[from]['USD'] * TEST_RATES['USD'][to];
        console.log(`Using USD-bridge fallback for ${from} -> ${to}: ${viaUsd}`);
        return viaUsd;
    }

    console.warn(`No exchange rate found for ${from} -> ${to}, defaulting to 1 (no conversion applied)`);
    return 1;
}

module.exports = router;