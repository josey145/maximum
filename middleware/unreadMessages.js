const db = require('../config/db');

const addUnreadCount = async (req, res, next) => {
    // Only for authenticated admin users
    if (req.session?.user?.role === 'admin') {
        try {
            const [[{ count }]] = await db.execute(`
                SELECT COUNT(*) as count 
                FROM user_messages 
                WHERE is_from_admin = FALSE AND status = 'unread'
            `);
            res.locals.unreadCount = count;
        } catch (error) {
            console.error('Error fetching unread count:', error);
            res.locals.unreadCount = 0;
        }
    } else {
        res.locals.unreadCount = 0;
    }
    next();
};

module.exports = { addUnreadCount };