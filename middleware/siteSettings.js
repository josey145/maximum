const db = require('../config/db');

// Cache settings to avoid DB hit on every request
let settingsCache = null;
let cacheTime = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

const loadSiteSettings = async (req, res, next) => {
    try {
        const now = Date.now();

        if (settingsCache && cacheTime && (now - cacheTime) < CACHE_DURATION) {
            res.locals.site = settingsCache;
            return next();
        }

        const [settings] = await db.execute(
            'SELECT setting_key, setting_value FROM site_settings'
        );

        const site = {
            name:              'Maximum',        // ← default fallback
            support_email:     '',
            support_phone:     '',
            support_whatsapp:  '',
            live_chat_enabled: false,
            maintenance_mode:  false,
            min_deposit:       '10',
            min_withdrawal:    '10',
            max_withdrawal:    '100000',
            current_year:      new Date().getFullYear(),
        };

        settings.forEach(row => {
            const key = row.setting_key;
            const val = row.setting_value;

            if (key === 'site_name') {
                site.name = val || 'Maximum';
            } else if (key === 'live_chat_enabled') {
                site.live_chat_enabled = val === '1';
            } else if (key === 'maintenance_mode') {
                site.maintenance_mode = val === '1';
            } else {
                site[key] = val;
            }
        });

        settingsCache = site;
        cacheTime = now;
        res.locals.site = site;
        next();

    } catch (error) {
        console.error('Failed to load site settings:', error);
        res.locals.site = {
            name:              'Maximum',
            support_email:     '',
            support_phone:     '',
            support_whatsapp:  '',
            live_chat_enabled: false,
            maintenance_mode:  false,
            min_deposit:       '10',
            min_withdrawal:    '10',
            max_withdrawal:    '100000',
            current_year:      new Date().getFullYear(),
        };
        next();
    }
};

const clearSettingsCache = () => {
    settingsCache = null;
    cacheTime = null;
};

module.exports = { loadSiteSettings, clearSettingsCache };