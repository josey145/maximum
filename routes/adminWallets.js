const express = require('express');
const router = express.Router();
const { ensureAdmin } = require('../middleware/authMiddleware');
const db = require('../config/db');
const telegramBot = require('../services/telegramBot');

// GET /admin/crypto-wallets - Manage crypto payment addresses
router.get('/crypto-wallets', ensureAdmin, async (req, res) => {
    try {
        // Get all crypto addresses grouped by symbol
        const [addresses] = await db.execute(`
            SELECT * FROM crypto_payment_addresses 
            ORDER BY symbol ASC, is_active DESC, created_at DESC
        `);

        // Group by cryptocurrency symbol
        const walletsByCrypto = {};
        addresses.forEach(addr => {
            if (!walletsByCrypto[addr.symbol]) {
                walletsByCrypto[addr.symbol] = [];
            }
            walletsByCrypto[addr.symbol].push(addr);
        });

        // Get unique symbols for the add form dropdown
        const uniqueSymbols = [...new Set(addresses.map(a => a.symbol))];

        // Get deposit stats per address
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

        res.render('admin/crypto-wallets', {
            title: 'Crypto Wallet Management',
            walletsByCrypto,
            uniqueSymbols,
            depositStats,
            currentUser: req.session.user
        });

    } catch (error) {
        console.error('Crypto wallet management error:', error);
        req.flash('error', 'Failed to load wallet management: ' + error.message);
        res.redirect('/admin');
    }
});

// POST /admin/crypto-wallets/add - Add new wallet address
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

        // name defaults to symbol if not provided
        const name = req.body.name || symbol.toUpperCase();

        await db.execute(`
            INSERT INTO crypto_payment_addresses 
            (name, symbol, address, network, qr_code, is_active, created_at, updated_at) 
            VALUES (?, ?, ?, ?, ?, TRUE, NOW(), NOW())
        `, [
            name,
            symbol.toUpperCase(),
            address,
            network || 'Mainnet',
            qr_code || null
        ]);

        await telegramBot.notifyAdminAction('Crypto Wallet Added', {
            admin: req.session.user.username,
            symbol: symbol.toUpperCase(),
            address: address.substring(0, 10) + '...' + address.slice(-6)
        });

        req.flash('success', `Wallet address added for ${symbol.toUpperCase()}`);
    } catch (error) {
        req.flash('error', error.message);
    }
    res.redirect('/admin/crypto-wallets');
});

// POST /admin/crypto-wallets/:id/update - Update wallet address
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

// POST /admin/crypto-wallets/:id/delete - Delete wallet address
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

        // Check if there are pending transactions using this address
        const [pendingTx] = await db.execute(`
            SELECT COUNT(*) as count FROM transactions 
            WHERE payment_method = 'crypto' 
            AND external_id = ? 
            AND status = 'pending'
        `, [wallets[0].symbol]);

        if (pendingTx[0].count > 0) {
            // Just deactivate instead of delete
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
            admin: req.session.user.username,
            symbol: wallets[0].symbol,
            address: wallets[0].address.substring(0, 10) + '...' + wallets[0].address.slice(-6)
        });

    } catch (error) {
        req.flash('error', error.message);
    }
    res.redirect('/admin/crypto-wallets');
});

// POST /admin/crypto-wallets/:id/toggle - Toggle active status
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

module.exports = router;