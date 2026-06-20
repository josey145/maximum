const express = require('express');
const router = express.Router();
const { ensureAuthenticated } = require('../middleware/authMiddleware');
const db = require('../config/db');
const { formatCurrency } = require('../utils/currency');

// Hardcoded rates fallback
const TEST_RATES = {
    'USD': { 'EUR': 0.92, 'GBP': 0.79, 'NGN': 1500, 'USD': 1 },
    'EUR': { 'USD': 1.09, 'EUR': 1 },
    'GBP': { 'USD': 1.27, 'GBP': 1 },
    'NGN': { 'USD': 0.00067, 'NGN': 1 }
};

router.get('/', ensureAuthenticated, async (req, res) => {
    try {
        const userId = req.session.user?.id;
        
        if (!userId) {
            req.flash('error', 'Please login');
            return res.redirect('/login');
        }

        // Get FULL user data including kyc_status, account_verified, etc.
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
        const baseCurrency = user.balance_currency || user.currency || 'USD';
        
        // Get user's holdings/investments with current prices
        const [holdings] = await db.execute(`
            SELECT h.*, 
                   COALESCE(h.current_price, 0) as price,
                   (h.amount * COALESCE(h.current_price, 0)) as value
            FROM holdings h 
            WHERE h.user_id = ?
        `, [userId]);
        
        // Calculate portfolio value
        const totalValueBase = holdings.reduce((sum, h) => sum + parseFloat(h.value || 0), 0);
        
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
        
        // Get recent closed trades for activity feed
        const [recentTrades] = await db.execute(`
            SELECT t.*, p.name as pair_name, p.symbol
            FROM forex_trades t
            LEFT JOIN forex_pairs p ON t.pair_id = p.id
            WHERE t.user_id = ? AND t.status = 'closed'
            ORDER BY t.closed_at DESC
            LIMIT 5
        `, [userId]);
        
        // Get active/open trades (investments)
        const [activeInvestments] = await db.execute(`
            SELECT t.*, p.name as pair_name, p.symbol
            FROM forex_trades t
            LEFT JOIN forex_pairs p ON t.pair_id = p.id
            WHERE t.user_id = ? AND t.status = 'open'
            ORDER BY t.opened_at DESC
        `, [userId]);
        
        // Calculate active investment value
        const activeInvestmentValue = activeInvestments.reduce((sum, trade) => {
            return sum + parseFloat(trade.margin_required || 0) + parseFloat(trade.profit_loss || 0);
        }, 0);
        
        // ============================================
        // GET TOTAL DEPOSITS
        // ============================================
        const [[depositStats]] = await db.execute(`
            SELECT 
                COUNT(*) as total_deposits,
                COALESCE(SUM(CASE WHEN status IN ('completed', 'approved') THEN amount ELSE 0 END), 0) as total_deposited,
                COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) as pending_deposits
            FROM transactions 
            WHERE user_id = ? AND type = 'deposit'
        `, [userId]);

        // Get total withdrawals
        const [[withdrawalStats]] = await db.execute(`
            SELECT 
                COUNT(*) as total_withdrawals,
                COALESCE(SUM(CASE WHEN status = 'completed' OR status = 'approved' THEN amount ELSE 0 END), 0) as total_withdrawn
            FROM transactions 
            WHERE user_id = ? AND type = 'withdrawal'
        `, [userId]);
        
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

        // Get latest unread message to show as dashboard alert
        const [latestMessages] = await db.execute(`
            SELECT m.*, a.username as admin_username
            FROM user_messages m
            JOIN users a ON m.admin_id = a.id
            WHERE m.user_id = ? AND m.status = 'unread' AND m.is_from_admin = TRUE AND m.parent_id IS NULL
            ORDER BY m.created_at DESC
            LIMIT 1
        `, [userId]);

        // ============================================
        // CURRENCY CONVERSION
        // ============================================
        let displayBalance = parseFloat(user.balance);
        let displayTotalValue = totalValueBase;
        let displayActiveInvestment = activeInvestmentValue;
        let displayTotalPnL = parseFloat(stats.total_pnl || 0);
        let displayUnrealizedPnL = parseFloat(stats.unrealized_pnl || 0);
        let displayTotalDeposited = parseFloat(depositStats.total_deposited || 0);
        let displayPendingDeposits = parseFloat(depositStats.pending_deposits || 0);
        let displayTotalWithdrawn = parseFloat(withdrawalStats.total_withdrawn || 0);

        // Convert currencies
        if (baseCurrency !== displayCurrency) {
            const rate = await getRate(baseCurrency, displayCurrency);
            console.log(`Converting ${baseCurrency} -> ${displayCurrency} at rate ${rate}`);
            displayBalance = displayBalance * rate;
            displayTotalValue = displayTotalValue * rate;
            displayActiveInvestment = displayActiveInvestment * rate;
            displayTotalPnL = displayTotalPnL * rate;
            displayUnrealizedPnL = displayUnrealizedPnL * rate;
            displayTotalDeposited = displayTotalDeposited * rate;
            displayPendingDeposits = displayPendingDeposits * rate;
            displayTotalWithdrawn = displayTotalWithdrawn * rate;
        }

        // ============================================
        // ADD MESSAGES TO WARNINGS (NO DEPOSIT WARNINGS)
        // ============================================
        
        // Add latest unread message as warning only
        const latestMessage = latestMessages[0];
        if (latestMessage) {
            // Determine message type based on admin message type
            let msgType = 'general';
            if (latestMessage.type === 'warning' || latestMessage.priority === 'high') {
                msgType = 'warning';
            } else if (latestMessage.type === 'pending' || latestMessage.priority === 'medium') {
                msgType = 'pending';
            } else if (latestMessage.type === 'welcome') {
                msgType = 'welcome';
            } else if (latestMessage.type === 'general') {
                msgType = 'general';
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
        console.log('Warnings:', warnings);

        // Format for display
        const balanceFormatted = formatCurrency(displayBalance, displayCurrency);
        const totalValueFormatted = formatCurrency(displayTotalValue, displayCurrency);
        const activeInvestmentFormatted = formatCurrency(displayActiveInvestment, displayCurrency);
        const totalPnLFormatted = formatCurrency(displayTotalPnL, displayCurrency);
        const unrealizedPnLFormatted = formatCurrency(displayUnrealizedPnL, displayCurrency);
        
        // FORMAT DEPOSIT STATS
        const totalDepositsFormatted = formatCurrency(displayTotalDeposited, displayCurrency);
        const pendingDepositsFormatted = formatCurrency(displayPendingDeposits, displayCurrency);
        const totalWithdrawalsFormatted = formatCurrency(displayTotalWithdrawn, displayCurrency);
        
        // Update session with fresh data
        req.session.user = {
            ...req.session.user,
            ...user,
            balance: user.balance,
            kyc_status: user.kyc_status,
            account_verified: user.account_verified
        };

        res.render('dashboard/dashboard', { 
            title: 'Dashboard - Maximum',
            user: user,
            holdings: holdings,
            totalValue: displayTotalValue,
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
            totalDepositsCount: depositStats.total_deposits || 0,
            pendingDepositsCount: depositStats.total_deposits > 0 ? 
                Math.round((depositStats.pending_deposits / depositStats.total_deposits) * 100) : 0,
            totalWithdrawalsCount: withdrawalStats.total_withdrawals || 0,
            warnings: warnings,
            unreadMessages: unreadMessages || 0,
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