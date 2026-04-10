
require('dotenv').config();

const express    = require('express');
const session    = require('express-session');
const flash      = require('connect-flash');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const http       = require('http');
const { Server } = require('socket.io');
const { exec }   = require('child_process');

const { loadSiteSettings } = require('./middleware/siteSettings');
const { addUnreadCount }   = require('./middleware/unreadMessages');
const telegramBot          = require('./services/telegramBot');
const signalBot            = require('./services/signalBot');
const { formatCurrency }   = require('./utils/currency');
const tradingViewService   = require('./services/tradingViewService');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

// Trust proxy for ngrok/production
app.set('trust proxy', 1);

// ==================== SERVICES ====================
tradingViewService.initialize(io);
app.locals.tradingViewService = tradingViewService;
app.locals.formatCurrency = (amount, currency = 'USD') =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
console.log('✅ TradingView service initialized');

// ==================== SECURITY ====================
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc:    ["'self'"],
            styleSrc:      ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            scriptSrc:     ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://s3.tradingview.com"],
            scriptSrcAttr: ["'unsafe-inline'"],
            fontSrc:       ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc:        ["'self'", "data:", "https:"],
            connectSrc:    ["'self'", "https://api.coingecko.com", "wss:", "ws:", "https://cdn.jsdelivr.net", "https://s3.tradingview.com"],
            workerSrc:     ["'self'", "blob:"],
            frameSrc:      ["'self'", "https://s.tradingview.com"]
        }
    }
}));

app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

// ==================== BODY & SESSION ====================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret:            process.env.SESSION_SECRET || 'fallback_secret_change_this',
    resave:            false,
    saveUninitialized: false,
    cookie: {
        secure:   process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge:   24 * 60 * 60 * 1000
    }
}));

// ==================== FLASH ====================
app.use(flash());

// ==================== SINGLE GLOBAL LOCALS BLOCK ====================
app.use((req, res, next) => {
    res.locals.user        = req.session.user || null;
    res.locals.success_msg = req.flash('success');
    res.locals.error_msg   = req.flash('error');
    res.locals.messages    = {
        error:   req.flash('error'),
        success: req.flash('success')
    };
    res.locals.signalBotConfigured = signalBot.isConfigured();
    next();
});

// ==================== UNREAD COUNTS ====================
app.use(addUnreadCount);

app.use(async (req, res, next) => {
    const db = require('./config/db');
    try {
        if (req.session?.user?.role === 'admin') {
            const [[{ count }]] = await db.execute(`
                SELECT COUNT(*) as count FROM user_messages 
                WHERE is_from_admin = FALSE AND status = 'unread'
            `);
            res.locals.unreadCount    = count;
            res.locals.unreadMessages = 0;
        } else if (req.session?.user) {
            const [[{ count }]] = await db.execute(`
                SELECT COUNT(*) as count FROM user_messages 
                WHERE user_id = ? AND status = 'unread' AND is_from_admin = TRUE
            `, [req.session.user.id]);
            res.locals.unreadCount    = 0;
            res.locals.unreadMessages = count;
        } else {
            res.locals.unreadCount    = 0;
            res.locals.unreadMessages = 0;
        }
    } catch {
        res.locals.unreadCount    = 0;
        res.locals.unreadMessages = 0;
    }
    next();
});

// ==================== SITE SETTINGS ====================
app.use(loadSiteSettings);

// ==================== MAINTENANCE MODE ====================
app.use((req, res, next) => {
    if (!res.locals.site?.maintenance_mode) return next();

    const isAdmin       = req.session.user?.role === 'admin';
    if (isAdmin) return next();

    const isStaticAsset = /\.(css|js|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|map)$/.test(req.path);
    if (isStaticAsset) return next();

    const allowedPaths  = ['/login', '/logout', '/auth', '/admin', '/webhook', '/test-telegram'];
    const isAllowed     = allowedPaths.some(p =>
        req.path === p || req.path.startsWith(p + '/') || req.path.startsWith(p + '?')
    );
    if (isAllowed) return next();

    return res.status(503).render('maintenance', { site: res.locals.site, title: 'Under Maintenance' });
});

// ==================== STATIC & VIEW ENGINE ====================
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ==================== REQUEST LOGGER ====================
app.use((req, res, next) => {
    console.log('📨 Request:', req.method, req.url);
    next();
});

// ==================== WEBHOOK ====================
app.post('/webhook/tradingview', async (req, res) => {
    try {
        const data = req.body;
        if (!data.symbol || !data.price) {
            return res.status(400).json({ success: false, error: 'Missing symbol or price' });
        }
        await tradingViewService.handleWebhook(data);
        res.json({ success: true, message: 'Price updated', symbol: data.symbol, timestamp: new Date() });
    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== TEST ROUTES ====================
app.get('/test-telegram', async (req, res) => {
    await telegramBot.notifyNewRegistration({
        userId: 999, username: 'TestUser',
        email: 'test@test.com', ip: '127.0.0.1', totalUsers: 100
    });
    res.send('Check your Telegram!');
});

app.get('/test-telegram-id', (req, res) => {
    res.json({ chatId: telegramBot.chatId, enabled: telegramBot.enabled, appUrl: telegramBot.appUrl });
});

// ==================== ROUTE IMPORTS ====================
const publicRoutes            = require('./routes/public');
const authRoutes              = require('./routes/auth');
const dashboardRoutes         = require('./routes/dashboard');
const transactionsRoutes      = require('./routes/transactions');
const adminRoutes             = require('./routes/admin');
const adminCryptoWalletRoutes = require('./routes/adminWallets');
const profileRoutes           = require('./routes/profile');
const tradingRoutes           = require('./routes/trading');
const userMessageRoutes       = require('./routes/messages');
const editRoutes              = require('./routes/edit');
const apiRouter               = require('./routes/api');
console.log('✅ Routes imported');

// ==================== ROUTE MOUNTING ====================
app.use('/',                     publicRoutes);
app.use('/',                     authRoutes);
app.use('/dashboard',            dashboardRoutes);
app.use('/transactions',         transactionsRoutes);
app.use('/admin',                adminRoutes);
app.use('/admin/crypto-wallets', adminCryptoWalletRoutes);
app.use('/profile',              profileRoutes);
app.use('/trading',              tradingRoutes);
app.use('/investments',          require('./routes/investments'));
app.use('/edit',                 editRoutes);


app.use('/messages',              userMessageRoutes);
app.use('/api',                     apiRouter);

// ==================== SOCKET.IO ====================
const priceSocket = require('./sockets/priceSocket');
priceSocket(io);

// ==================== 404 & ERROR ====================
app.use((req, res) => {
    res.status(404).render('error', { title: 'Page Not Found', message: 'Page not found' });
});

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).render('error', {
        title:   'Error',
        message: process.env.NODE_ENV === 'production' ? 'Something went wrong!' : err.message
    });
});



// ==================== START SERVER ====================
const PORT = process.env.PORT || 3000;
exec(
    `FOR /F "tokens=5" %a IN ('netstat -ano ^| findstr :${PORT}') DO taskkill /F /PID %a 2>nul`,
    () => {
        setTimeout(() => {
            server.listen(PORT, () => {
                console.log(`🚀 Server running on port ${PORT}`);
                console.log(`📊 TradingView webhook: http://localhost:${PORT}/webhook/tradingview`);
                console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
            });
        }, 1000);
    }
);