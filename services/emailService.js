const { Resend } = require('resend');
const db = require('../config/db');

// Cache site name to avoid DB hits
let cachedSiteName = null;
let cacheTime = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Get site name from database
async function getSiteName() {
    const now = Date.now();
    if (cachedSiteName && cacheTime && (now - cacheTime) < CACHE_DURATION) {
        return cachedSiteName;
    }
    
    try {
        const [settings] = await db.execute(
            "SELECT setting_value FROM site_settings WHERE setting_key = 'site_name'"
        );
        cachedSiteName = settings[0]?.setting_value || 'CUE-ACTION';
        cacheTime = now;
        return cachedSiteName;
    } catch (e) {
        return 'CUE-ACTION';
    }
}

// Clear cache when needed
function clearSiteNameCache() {
    cachedSiteName = null;
    cacheTime = null;
}

// Initialize Resend with API key
const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * Generic email sender with dynamic site name
 * @param {object} options - { to, subject, html }
 */
const sendEmail = async ({ to, subject, html }) => {
    try {
        const siteName = await getSiteName();
        
        // Replace all instances of "Maximum" with actual site name in HTML
        let processedHtml = html;
        if (siteName !== 'Maximum') {
            processedHtml = html
                .replace(/Maximum Platform/g, siteName)
                .replace(/Maximum/g, siteName);
        }
        
        const data = await resend.emails.send({
            from: `${siteName} <support@cue-action.online>`,
            to: to,
            subject: subject.replace(/Maximum/g, siteName),
            html: processedHtml
        });
        
        console.log(`✅ Email sent to ${to}: ${data.id}`);
        return data;
    } catch (error) {
        console.error(`❌ Failed to send email to ${to}:`, error.message);
        throw error;
    }
};

module.exports = { sendEmail, clearSiteNameCache, getSiteName };