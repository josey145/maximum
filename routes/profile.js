const express = require('express');
const router = express.Router();
const { ensureAuthenticated } = require('../middleware/authMiddleware');
const db = require('../config/db');
const { getExchangeRate } = require('../utils/currency'); // ← import the util

const SUPPORTED_CURRENCIES = [
    // Major
    { code: 'USD', name: 'US Dollar',           symbol: '$',  flag: '🇺🇸' },
    { code: 'EUR', name: 'Euro',                symbol: '€',  flag: '🇪🇺' },
    { code: 'GBP', name: 'British Pound',       symbol: '£',  flag: '🇬🇧' },
    { code: 'JPY', name: 'Japanese Yen',        symbol: '¥',  flag: '🇯🇵' },
    { code: 'CHF', name: 'Swiss Franc',         symbol: 'Fr', flag: '🇨🇭' },
    { code: 'CAD', name: 'Canadian Dollar',     symbol: 'C$', flag: '🇨🇦' },
    { code: 'AUD', name: 'Australian Dollar',   symbol: 'A$', flag: '🇦🇺' },
    // Asia
    { code: 'CNY', name: 'Chinese Yuan',        symbol: '¥',  flag: '🇨🇳' },
    { code: 'INR', name: 'Indian Rupee',        symbol: '₹',  flag: '🇮🇳' },
    { code: 'KRW', name: 'South Korean Won',    symbol: '₩',  flag: '🇰🇷' },
    { code: 'SGD', name: 'Singapore Dollar',    symbol: 'S$', flag: '🇸🇬' },
    { code: 'HKD', name: 'Hong Kong Dollar',    symbol: 'HK$',flag: '🇭🇰' },
    { code: 'MYR', name: 'Malaysian Ringgit',   symbol: 'RM', flag: '🇲🇾' },
    { code: 'IDR', name: 'Indonesian Rupiah',   symbol: 'Rp', flag: '🇮🇩' },
    { code: 'THB', name: 'Thai Baht',           symbol: '฿',  flag: '🇹🇭' },
    { code: 'PHP', name: 'Philippine Peso',     symbol: '₱',  flag: '🇵🇭' },
    { code: 'VND', name: 'Vietnamese Dong',     symbol: '₫',  flag: '🇻🇳' },
    { code: 'PKR', name: 'Pakistani Rupee',     symbol: '₨',  flag: '🇵🇰' },
    { code: 'BDT', name: 'Bangladeshi Taka',    symbol: '৳',  flag: '🇧🇩' },
    // Middle East
    { code: 'AED', name: 'UAE Dirham',          symbol: 'د.إ',flag: '🇦🇪' },
    { code: 'SAR', name: 'Saudi Riyal',         symbol: '﷼',  flag: '🇸🇦' },
    { code: 'QAR', name: 'Qatari Riyal',        symbol: 'QR', flag: '🇶🇦' },
    { code: 'KWD', name: 'Kuwaiti Dinar',       symbol: 'KD', flag: '🇰🇼' },
    { code: 'BHD', name: 'Bahraini Dinar',      symbol: 'BD', flag: '🇧🇭' },
    { code: 'OMR', name: 'Omani Rial',          symbol: 'OMR',flag: '🇴🇲' },
    { code: 'JOD', name: 'Jordanian Dinar',     symbol: 'JD', flag: '🇯🇴' },
    { code: 'TRY', name: 'Turkish Lira',        symbol: '₺',  flag: '🇹🇷' },
    { code: 'ILS', name: 'Israeli Shekel',      symbol: '₪',  flag: '🇮🇱' },
    // Africa
    { code: 'NGN', name: 'Nigerian Naira',      symbol: '₦',  flag: '🇳🇬' },
    { code: 'GHS', name: 'Ghanaian Cedi',       symbol: '₵',  flag: '🇬🇭' },
    { code: 'KES', name: 'Kenyan Shilling',     symbol: 'KSh',flag: '🇰🇪' },
    { code: 'ZAR', name: 'South African Rand',  symbol: 'R',  flag: '🇿🇦' },
    { code: 'EGP', name: 'Egyptian Pound',      symbol: 'E£', flag: '🇪🇬' },
    { code: 'MAD', name: 'Moroccan Dirham',     symbol: 'MAD',flag: '🇲🇦' },
    { code: 'TZS', name: 'Tanzanian Shilling',  symbol: 'TSh',flag: '🇹🇿' },
    { code: 'UGX', name: 'Ugandan Shilling',    symbol: 'USh',flag: '🇺🇬' },
    { code: 'ETB', name: 'Ethiopian Birr',      symbol: 'Br', flag: '🇪🇹' },
    { code: 'XOF', name: 'West African CFA',    symbol: 'CFA',flag: '🌍' },
    // Americas
    { code: 'BRL', name: 'Brazilian Real',      symbol: 'R$', flag: '🇧🇷' },
    { code: 'MXN', name: 'Mexican Peso',        symbol: '$',  flag: '🇲🇽' },
    { code: 'ARS', name: 'Argentine Peso',      symbol: '$',  flag: '🇦🇷' },
    { code: 'COP', name: 'Colombian Peso',      symbol: '$',  flag: '🇨🇴' },
    { code: 'CLP', name: 'Chilean Peso',        symbol: '$',  flag: '🇨🇱' },
    // Europe
    { code: 'NOK', name: 'Norwegian Krone',     symbol: 'kr', flag: '🇳🇴' },
    { code: 'SEK', name: 'Swedish Krona',       symbol: 'kr', flag: '🇸🇪' },
    { code: 'DKK', name: 'Danish Krone',        symbol: 'kr', flag: '🇩🇰' },
    { code: 'PLN', name: 'Polish Zloty',        symbol: 'zł', flag: '🇵🇱' },
    { code: 'CZK', name: 'Czech Koruna',        symbol: 'Kč', flag: '🇨🇿' },
    { code: 'HUF', name: 'Hungarian Forint',    symbol: 'Ft', flag: '🇭🇺' },
    { code: 'RON', name: 'Romanian Leu',        symbol: 'lei',flag: '🇷🇴' },
    { code: 'RUB', name: 'Russian Ruble',       symbol: '₽',  flag: '🇷🇺' },
    { code: 'UAH', name: 'Ukrainian Hryvnia',   symbol: '₴',  flag: '🇺🇦' },
];

// ==================== HELPERS ====================

/**
 * Resolve exchange rate using a 3-step strategy:
 *   1. Direct DB lookup (e.g. EUR → INR)
 *   2. Reverse DB lookup then invert (e.g. INR → EUR, inverted)
 *   3. USD pivot via DB (e.g. EUR → USD → INR)
 *
 * Returns null if no rate can be resolved.
 */
async function resolveRate(from, to) {
    if (from === to) return 1;

    // Step 1 & 2: handled inside getExchangeRate (direct + reverse)
    // getExchangeRate returns 1 as fallback — we need to detect "not found"
    // so we do the DB calls manually here.

    // Direct
    const [direct] = await db.execute(
        'SELECT rate FROM exchange_rates WHERE from_currency = ? AND to_currency = ?',
        [from, to]
    );
    if (direct.length > 0) return parseFloat(direct[0].rate);

    // Reverse
    const [reverse] = await db.execute(
        'SELECT rate FROM exchange_rates WHERE from_currency = ? AND to_currency = ?',
        [to, from]
    );
    if (reverse.length > 0) return 1 / parseFloat(reverse[0].rate);

    // USD pivot: from → USD → to
    if (from !== 'USD' && to !== 'USD') {
        const [toUSD] = await db.execute(
            'SELECT rate FROM exchange_rates WHERE from_currency = ? AND to_currency = ?',
            [from, 'USD']
        );
        const [fromUSD] = await db.execute(
            'SELECT rate FROM exchange_rates WHERE from_currency = ? AND to_currency = ?',
            ['USD', to]
        );

        // Also try reverse lookups for each leg
        let rateToUSD = null;
        let rateFromUSD = null;

        if (toUSD.length > 0) {
            rateToUSD = parseFloat(toUSD[0].rate);
        } else {
            const [revToUSD] = await db.execute(
                'SELECT rate FROM exchange_rates WHERE from_currency = ? AND to_currency = ?',
                ['USD', from]
            );
            if (revToUSD.length > 0) rateToUSD = 1 / parseFloat(revToUSD[0].rate);
        }

        if (fromUSD.length > 0) {
            rateFromUSD = parseFloat(fromUSD[0].rate);
        } else {
            const [revFromUSD] = await db.execute(
                'SELECT rate FROM exchange_rates WHERE from_currency = ? AND to_currency = ?',
                [to, 'USD']
            );
            if (revFromUSD.length > 0) rateFromUSD = 1 / parseFloat(revFromUSD[0].rate);
        }

        if (rateToUSD && rateFromUSD) {
            return rateToUSD * rateFromUSD;
        }
    }

    // Truly not found
    return null;
}


// ==================== GET /profile ====================

router.get('/', ensureAuthenticated, async (req, res) => {
    try {
        const [users] = await db.execute(`
            SELECT id, username, email, phone, dob, country, state, city, 
                   zip, address, currency, balance_currency, balance,
                   kyc_status, account_verified, created_at, role
            FROM users WHERE id = ?
        `, [req.session.user.id]);

        if (users.length === 0) return res.redirect('/dashboard');

        const [transactions] = await db.execute(`
            SELECT * FROM transactions 
            WHERE user_id = ? 
            ORDER BY created_at DESC LIMIT 5
        `, [req.session.user.id]);

        res.render('profile/profile', {
            title:       'Profile - ' + (res.locals.site?.name || 'Maximum'),
            user:        users[0],
            transactions,
            currencies:  SUPPORTED_CURRENCIES
        });
    } catch (error) {
        console.error('Profile error:', error);
        res.redirect('/dashboard');
    }
});


// ==================== GET /profile/settings ====================

router.get('/settings', ensureAuthenticated, async (req, res) => {
    try {
        const [users] = await db.execute(`
            SELECT id, username, email, phone, dob, country, state, city,
                   zip, address, currency, balance_currency, balance,
                   kyc_status, account_verified, created_at
            FROM users WHERE id = ?
        `, [req.session.user.id]);

        if (users.length === 0) return res.redirect('/dashboard');

        res.render('profile/settings', {
            title:      'Settings - ' + (res.locals.site?.name || 'Maximum'),
            user:       users[0],
            currencies: SUPPORTED_CURRENCIES
        });
    } catch (error) {
        console.error('Settings error:', error);
        res.redirect('/profile');
    }
});


// ==================== GET /profile/edit ====================

router.get('/edit', ensureAuthenticated, async (req, res) => {
    try {
        const [users] = await db.execute(`
            SELECT id, username, email, phone, dob, country, state, city,
                   zip, address, currency, balance_currency, balance
            FROM users WHERE id = ?
        `, [req.session.user.id]);

        if (users.length === 0) return res.redirect('/profile');

        res.render('profile/edit', {
            title:      'Edit Profile - ' + (res.locals.site?.name || 'Maximum'),
            user:       users[0],
            currencies: SUPPORTED_CURRENCIES
        });
    } catch (error) {
        console.error('Edit profile error:', error);
        res.redirect('/profile');
    }
});


// ==================== POST /profile/update ====================

router.post('/update', ensureAuthenticated, async (req, res) => {
    try {
        const { phone, dob, country, state, city, zip, address, currency } = req.body;

        const [users] = await db.execute(
            'SELECT balance, currency, balance_currency FROM users WHERE id = ?',
            [req.session.user.id]
        );

        if (users.length === 0) {
            req.flash('error', 'User not found');
            return res.redirect('/profile');
        }

        const currentUser    = users[0];
        const oldCurrency    = currentUser.currency || 'USD';
        const newCurrency    = currency;
        const baseCurrency   = currentUser.balance_currency || oldCurrency;

        let finalBalance         = parseFloat(currentUser.balance);
        let finalBalanceCurrency = baseCurrency;

        // Convert balance if currency changed
        if (newCurrency && newCurrency !== oldCurrency) {
            const rate = await resolveRate(baseCurrency, newCurrency);

            if (rate !== null) {
                finalBalance         = finalBalance * rate;
                finalBalanceCurrency = newCurrency;
            } else {
                req.flash('error', `Exchange rate from ${baseCurrency} to ${newCurrency} not available. Please contact support.`);
                return res.redirect('/profile/settings');
            }
        }

        const validCodes   = SUPPORTED_CURRENCIES.map(c => c.code);
        const safeCurrency = validCodes.includes(newCurrency) ? newCurrency : 'USD';
        const safeDob      = dob && dob.trim() !== '' ? dob : null;

        await db.execute(`
            UPDATE users SET
                phone = ?, dob = ?, country = ?, state = ?,
                city = ?, zip = ?, address = ?,
                currency = ?, balance = ?, balance_currency = ?,
                updated_at = NOW()
            WHERE id = ?
        `, [phone, safeDob, country, state, city, zip, address,
            safeCurrency, finalBalance, finalBalanceCurrency,
            req.session.user.id]);

        req.session.user.currency         = safeCurrency;
        req.session.user.balance          = finalBalance;
        req.session.user.balance_currency = finalBalanceCurrency;

        req.flash('success', 'Profile updated successfully');
        res.redirect('/profile/settings');

    } catch (error) {
        console.error('Profile update error:', error);
        req.flash('error', 'Failed to update profile: ' + error.message);
        res.redirect('/profile/settings');
    }
});


// ==================== POST /profile/change-password ====================

router.post('/change-password', ensureAuthenticated, async (req, res) => {
    try {
        const { current_password, new_password, confirm_password } = req.body;
        const bcrypt = require('bcryptjs');

        if (new_password !== confirm_password) {
            req.flash('error', 'New passwords do not match');
            return res.redirect('/profile/settings');
        }

        if (new_password.length < 8) {
            req.flash('error', 'Password must be at least 8 characters');
            return res.redirect('/profile/settings');
        }

        const [users] = await db.execute(
            'SELECT password FROM users WHERE id = ?',
            [req.session.user.id]
        );

        const isMatch = await bcrypt.compare(current_password, users[0].password);
        if (!isMatch) {
            req.flash('error', 'Current password is incorrect');
            return res.redirect('/profile/settings');
        }

        const hashed = await bcrypt.hash(new_password, 12);
        await db.execute(
            'UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?',
            [hashed, req.session.user.id]
        );

        req.flash('success', 'Password changed successfully');
        res.redirect('/profile/settings');

    } catch (error) {
        req.flash('error', 'Failed to change password: ' + error.message);
        res.redirect('/profile/settings');
    }
});


module.exports = router;