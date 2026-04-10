// utils/currency.js
const db = require('../config/db');

/**
 * Get exchange rate between two currencies using a 3-step strategy:
 *   1. Direct DB lookup               (EUR → INR)
 *   2. Reverse DB lookup + invert     (INR → EUR  →  1 / rate)
 *   3. USD pivot                      (EUR → USD → INR)
 *
 * Returns 1 if no rate can be resolved (safe no-op fallback).
 * Returns null from resolveRate() when you need to detect "not found" explicitly.
 */

/**
 * Internal: resolve a rate, returning null if truly unavailable.
 */
async function resolveRate(fromCurrency, toCurrency) {
    if (fromCurrency === toCurrency) return 1;

    // Step 1 — direct
    const [direct] = await db.execute(
        'SELECT rate FROM exchange_rates WHERE from_currency = ? AND to_currency = ?',
        [fromCurrency, toCurrency]
    );
    if (direct.length > 0) return parseFloat(direct[0].rate);

    // Step 2 — reverse
    const [reverse] = await db.execute(
        'SELECT rate FROM exchange_rates WHERE from_currency = ? AND to_currency = ?',
        [toCurrency, fromCurrency]
    );
    if (reverse.length > 0) return 1 / parseFloat(reverse[0].rate);

    // Step 3 — USD pivot (only when neither leg is already USD)
    if (fromCurrency !== 'USD' && toCurrency !== 'USD') {
        let rateToUSD   = null;
        let rateFromUSD = null;

        // from → USD
        const [leg1] = await db.execute(
            'SELECT rate FROM exchange_rates WHERE from_currency = ? AND to_currency = ?',
            [fromCurrency, 'USD']
        );
        if (leg1.length > 0) {
            rateToUSD = parseFloat(leg1[0].rate);
        } else {
            const [leg1Rev] = await db.execute(
                'SELECT rate FROM exchange_rates WHERE from_currency = ? AND to_currency = ?',
                ['USD', fromCurrency]
            );
            if (leg1Rev.length > 0) rateToUSD = 1 / parseFloat(leg1Rev[0].rate);
        }

        // USD → to
        const [leg2] = await db.execute(
            'SELECT rate FROM exchange_rates WHERE from_currency = ? AND to_currency = ?',
            ['USD', toCurrency]
        );
        if (leg2.length > 0) {
            rateFromUSD = parseFloat(leg2[0].rate);
        } else {
            const [leg2Rev] = await db.execute(
                'SELECT rate FROM exchange_rates WHERE from_currency = ? AND to_currency = ?',
                [toCurrency, 'USD']
            );
            if (leg2Rev.length > 0) rateFromUSD = 1 / parseFloat(leg2Rev[0].rate);
        }

        if (rateToUSD !== null && rateFromUSD !== null) {
            return rateToUSD * rateFromUSD;
        }
    }

    return null; // truly not resolvable
}

/**
 * Get exchange rate between two currencies.
 * Returns 1 as a safe fallback if no rate is found (logs a warning).
 *
 * @param {string} fromCurrency - Source currency code (e.g. 'EUR')
 * @param {string} toCurrency   - Target currency code (e.g. 'INR')
 * @returns {Promise<number>}   Exchange rate
 */
async function getExchangeRate(fromCurrency, toCurrency) {
    if (fromCurrency === toCurrency) return 1;

    const rate = await resolveRate(fromCurrency, toCurrency);

    if (rate === null) {
        console.warn(`No exchange rate found for ${fromCurrency} → ${toCurrency}`);
        return 1; // safe no-op fallback
    }

    return rate;
}

/**
 * Convert an amount between currencies.
 * Returns the original amount unchanged if no rate is found.
 *
 * @param {number} amount        - Amount to convert
 * @param {string} fromCurrency  - Source currency code
 * @param {string} toCurrency    - Target currency code
 * @returns {Promise<number>}    Converted amount
 */
async function convertCurrency(amount, fromCurrency, toCurrency) {
    if (fromCurrency === toCurrency) return amount;
    const rate = await getExchangeRate(fromCurrency, toCurrency);
    return amount * rate;
}

/**
 * Format a currency amount for display.
 *
 * @param {number} amount   - Amount to format
 * @param {string} currency - Currency code (e.g. 'USD')
 * @returns {string}        Formatted string (e.g. '$1,234.56')
 */
function formatCurrency(amount, currency) {
    const symbols = {
        'USD': '$',  'EUR': '€',  'GBP': '£',  'NGN': '₦',
        'JPY': '¥',  'BTC': '₿',  'INR': '₹',  'CAD': 'C$',
        'AUD': 'A$', 'CHF': 'Fr', 'CNY': '¥',  'KRW': '₩',
        'SGD': 'S$', 'HKD': 'HK$','AED': 'د.إ','SAR': '﷼',
        'TRY': '₺',  'BRL': 'R$', 'MXN': '$',  'ZAR': 'R',
    };

    const symbol = symbols[currency] || (currency + ' ');

    if (currency === 'BTC') {
        return symbol + parseFloat(amount).toFixed(8);
    }

    // Large numbers (e.g. IDR, VND, NGN) get locale formatting
    if (Math.abs(amount) >= 1000) {
        return symbol + parseFloat(amount).toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
    }

    return symbol + parseFloat(amount).toFixed(2);
}

/**
 * Get all currencies available for conversion from a given base currency.
 * Defaults to USD as the base.
 *
 * @param {string} base - Base currency code (default: 'USD')
 * @returns {Promise<string[]>} Array of available target currency codes
 */
async function getAvailableCurrencies(base = 'USD') {
    const [rows] = await db.execute(
        'SELECT DISTINCT to_currency AS currency FROM exchange_rates WHERE from_currency = ?',
        [base]
    );
    return rows.map(r => r.currency);
}

module.exports = {
    resolveRate,           // use this when you need null on "not found"
    getExchangeRate,       // use this for general lookups (falls back to 1)
    convertCurrency,
    formatCurrency,
    getAvailableCurrencies,
};