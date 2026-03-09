const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();



const telegramBot = require('./services/telegramBot');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Security Middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'", "https://api.coingecko.com", "wss:", "ws:"]
        }
    }
}));

// Rate Limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Stricter rate limiting for auth routes
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100, // Change from 5 to 100 for testing
    message: 'Too many authentication attempts, please try again later.'
});

// Body Parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session Configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback_secret_change_this',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

app.use(flash());

// Static Files
app.use(express.static(path.join(__dirname, 'public')));

// View Engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Make user available to all views
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.success_msg = req.flash('success');
    res.locals.error_msg = req.flash('error');
    next();
});

// Routes
const publicRoutes = require('./routes/public');
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const adminRoutes = require('./routes/admin');


// Add this BEFORE your routes
app.get('/test-telegram', async (req, res) => {
    const telegramBot = require('./services/telegramBot');
    
    console.log('Testing telegram...');
    console.log('Service:', telegramBot);
    console.log('Enabled:', telegramBot.enabled);
    
    await telegramBot.notifyNewRegistration({
        userId: 999,
        username: 'TestUser',
        email: 'test@test.com',
        ip: '127.0.0.1',
        totalUsers: 100
    });
    
    res.send('Check your console and Telegram!');
});

app.use('/', publicRoutes);
app.use('/', authRoutes);  // NEW - no rate limit
app.use('/dashboard', dashboardRoutes);
app.use('/admin', adminRoutes);

// Socket.IO for real-time prices
const priceSocket = require('./sockets/priceSocket');
priceSocket(io);

// Error Handling
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).render('error', { 
        title: 'Error',
        message: process.env.NODE_ENV === 'production' ? 'Something went wrong!' : err.message 
    });
});


app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'", "https://api.coingecko.com", "wss:", "ws:", "https://cdn.jsdelivr.net"],
            workerSrc: ["'self'", "blob:"]
        }
    }
}));

// Temporary test - add before routes
app.use((req, res, next) => {
    console.log('📨 Request:', req.method, req.url);
    next();
});

// 404 Handler
app.use((req, res) => {
    res.status(404).render('error', { 
        title: 'Page Not Found',
        message: 'Page not found' 
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});