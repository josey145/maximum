const axios = require('axios');
const db = require('../config/db');

class TradingViewService {
    constructor() {
        this.activePairs = new Map();
        this.clients = new Map(); // Store socket connections
    }

    // Initialize with socket.io
    initialize(io) {
        this.io = io;

        io.on('connection', (socket) => {
            console.log('TradingView client connected:', socket.id);

            // Join user-specific room for position updates
            socket.on('subscribe_user', (userId) => {
                socket.join(`user_${userId}`);
                console.log(`Socket ${socket.id} subscribed to user_${userId}`);
            });

            // Subscribe to pair updates
            socket.on('subscribe_pair', (symbol) => {
                socket.join(`pair_${symbol}`);
                console.log(`Socket ${socket.id} subscribed to pair_${symbol}`);
            });

            socket.on('disconnect', () => {
                console.log('TradingView client disconnected:', socket.id);
            });
        });
    }

    // Handle webhook from TradingView
    async handleWebhook(data) {
        const { secret, symbol, price, timestamp } = data;

        // Verify secret (optional security)
        const expectedSecret = process.env.TV_WEBHOOK_SECRET || 'your_webhook_secret';
        if (secret && secret !== expectedSecret) {
            throw new Error('Invalid webhook secret');
        }

        // Update pair in database
        try {
            await db.execute(
                'UPDATE forex_pairs SET bid = ?, ask = ?, spread = ?, updated_at = NOW() WHERE symbol = ?',
                [price.bid, price.ask, price.ask - price.bid, symbol]
            );
        } catch (e) {
            console.log('DB update error (table may not exist):', e.message);
        }

        // Store in memory
        this.activePairs.set(symbol, {
            bid: price.bid,
            ask: price.ask,
            timestamp: timestamp || new Date()
        });

        // Broadcast to all subscribed clients
        if (this.io) {
            this.io.to(`pair_${symbol}`).emit('forex_price', {
                symbol: symbol,
                bid: price.bid,
                ask: price.ask,
                spread: price.ask - price.bid
            });
        }

        // Check stop loss / take profit
        await this.checkPositions(symbol, price);

        return { success: true, symbol, price };
    }

    // Check and update positions
    async checkPositions(symbol, price) {
        try {
            const [positions] = await db.execute(`
                SELECT t.*, p.pip_value 
                FROM forex_trades t
                JOIN forex_pairs p ON t.pair_id = p.id
                WHERE t.pair_symbol = ? AND t.status = 'open'
            `, [symbol]);

            for (const pos of positions) {
                const currentPrice = pos.direction === 'buy' ? price.bid : price.ask;

                // Calculate P&L
                const pipSize = symbol.includes('JPY') ? 0.01 : 0.0001;
                let pipsProfit;

                if (pos.direction === 'buy') {
                    pipsProfit = (currentPrice - pos.entry_price) / pipSize;
                } else {
                    pipsProfit = (pos.entry_price - currentPrice) / pipSize;
                }

                const pipValue = pos.lot_size * 10; // $10 per pip per standard lot
                const profitLoss = pipsProfit * pipValue;

                // Update position in DB
                await db.execute(`
                    UPDATE forex_trades 
                    SET current_price = ?, pips_profit = ?, profit_loss = ?
                    WHERE id = ?
                `, [currentPrice, pipsProfit, profitLoss, pos.id]);

                // Check SL/TP
                let shouldClose = false;
                let closeReason = null;

                if (pos.stop_loss) {
                    if (pos.direction === 'buy' && currentPrice <= pos.stop_loss) {
                        shouldClose = true;
                        closeReason = 'sl';
                    } else if (pos.direction === 'sell' && currentPrice >= pos.stop_loss) {
                        shouldClose = true;
                        closeReason = 'sl';
                    }
                }

                if (pos.take_profit && !shouldClose) {
                    if (pos.direction === 'buy' && currentPrice >= pos.take_profit) {
                        shouldClose = true;
                        closeReason = 'tp';
                    } else if (pos.direction === 'sell' && currentPrice <= pos.take_profit) {
                        shouldClose = true;
                        closeReason = 'tp';
                    }
                }

                if (shouldClose) {
                    await this.closePosition(pos.id, currentPrice, closeReason);
                } else {
                    // Notify user of P&L update
                    if (this.io) {
                        this.io.to(`user_${pos.user_id}`).emit('position_update', {
                            positionId: pos.id,
                            currentPrice: currentPrice,
                            pipsProfit: pipsProfit,
                            profitLoss: profitLoss
                        });
                    }
                }
            }
        } catch (e) {
            console.log('Check positions error:', e.message);
        }
    }

    // Close a position
    async closePosition(positionId, exitPrice, reason = 'manual') {
        const connection = await db.getConnection();

        try {
            await connection.beginTransaction();

            const [positions] = await connection.execute(
                'SELECT * FROM forex_trades WHERE id = ? AND status = "open"',
                [positionId]
            );

            if (!positions.length) return;
            const pos = positions[0];

            // Calculate final P&L
            const pipSize = pos.pair_symbol.includes('JPY') ? 0.01 : 0.0001;
            let pipsProfit;

            if (pos.direction === 'buy') {
                pipsProfit = (exitPrice - pos.entry_price) / pipSize;
            } else {
                pipsProfit = (pos.entry_price - exitPrice) / pipSize;
            }

            const pipValue = pos.lot_size * 10;
            const profitLoss = pipsProfit * pipValue;

            // Close trade
            await connection.execute(`
                UPDATE forex_trades 
                SET status = 'closed',
                    exit_price = ?,
                    current_price = ?,
                    pips_profit = ?,
                    profit_loss = ?,
                    closed_at = NOW(),
                    close_reason = ?
                WHERE id = ?
            `, [exitPrice, exitPrice, pipsProfit, profitLoss, reason, positionId]);

            // Update user balance
            const balanceChange = profitLoss; // Can be positive or negative
            await connection.execute(`
                UPDATE users 
                SET balance = balance + ?,
                    free_margin = free_margin + ?,
                    used_margin = used_margin - ?
                WHERE id = ?
            `, [balanceChange, pos.margin_required, pos.margin_required, pos.user_id]);

            await connection.commit();

            // Notify user
            if (this.io) {
                this.io.to(`user_${pos.user_id}`).emit('trade_closed', {
                    positionId: positionId,
                    profitLoss: profitLoss,
                    closeReason: reason
                });
            }

            console.log(`Position ${positionId} closed. P&L: ${profitLoss}`);

        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // Get current price for a symbol
    getPrice(symbol) {
        return this.activePairs.get(symbol);
    }
}

// Export singleton instance
module.exports = new TradingViewService();