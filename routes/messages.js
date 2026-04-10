const express = require('express');
const router = express.Router();
const { ensureAuthenticated } = require('../middleware/authMiddleware');
const db = require('../config/db');
const telegramBot = require('../services/telegramBot');

const emailTemplate = ({
    badge, badgeColor,
    username, intro,
    rows, footerNote,
    siteName = 'Maximum',
    siteUrl = 'https://yourdomain.com'
}) => {
    const year = new Date().getFullYear();
    
    // Build rows HTML
    const rowsHtml = rows && rows.length > 0 ? rows.map(([label, val]) =>
        `<tr>
            <td style="padding:12px 0;border-bottom:1px solid #e5e7eb;">
                <span style="color:#6b7280;font-size:13px;">${label}</span>
            </td>
            <td style="padding:12px 0;border-bottom:1px solid #e5e7eb;text-align:right;">
                <span style="color:#111827;font-size:13px;font-weight:500;">${val}</span>
            </td>
        </tr>`
    ).join('') : '';

    // Build message body - clean, normal email style
    const messageBody = intro ? `
        <div style="background:#f9fafb;border-radius:8px;padding:20px;margin:20px 0;">
            <p style="color:#374151;font-size:15px;line-height:1.7;margin:0;">${intro}</p>
        </div>
    ` : '';

    // Build details table if there are rows
    const detailsTable = rowsHtml ? `
        <table style="width:100%;border-collapse:collapse;margin:20px 0;">
            ${rowsHtml}
        </table>
    ` : '';

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${badge}</title>
</head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
    <table role="presentation" style="width:100%;border-collapse:collapse;">
        <tr>
            <td align="center" style="padding:40px 20px;">
                <table role="presentation" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px -1px rgba(0,0,0,0.1);">
                    
                    <!-- Header -->
                    <tr>
                        <td style="background:linear-gradient(135deg,#8b5cf6,#6d28d9);padding:32px 40px;text-align:center;">
                            <h1 style="margin:0;color:#fff;font-size:24px;font-weight:700;letter-spacing:-0.5px;">${siteName}</h1>
                            <p style="margin:8px 0 0;color:rgba(255,255,255,0.8);font-size:13px;">Trading Platform</p>
                        </td>
                    </tr>
                    
                    <!-- Badge -->
                    <tr>
                        <td style="padding:32px 40px 0;">
                            <span style="display:inline-block;background:${badgeColor}15;color:${badgeColor};padding:6px 16px;border-radius:20px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">
                                ● ${badge}
                            </span>
                        </td>
                    </tr>
                    
                    <!-- Greeting -->
                    <tr>
                        <td style="padding:24px 40px 0;">
                            <p style="margin:0;color:#374151;font-size:16px;line-height:1.6;">
                                Hello <strong style="color:#111827;">${username}</strong>,
                            </p>
                        </td>
                    </tr>
                    
                    <!-- Message Body -->
                    <tr>
                        <td style="padding:0 40px;">
                            ${messageBody}
                            ${detailsTable}
                        </td>
                    </tr>
                    
                    <!-- CTA Button (if provided in footerNote) -->
                    <tr>
                        <td style="padding:0 40px 32px;">
                            <div style="text-align:center;margin-top:24px;">
                                <a href="${siteUrl}/messages" style="display:inline-block;background:linear-gradient(135deg,#8b5cf6,#6d28d9);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:600;">
                                    View Message & Reply
                                </a>
                            </div>
                        </td>
                    </tr>
                    
                    <!-- Footer -->
                    <tr>
                        <td style="background:#f9fafb;padding:24px 40px;text-align:center;border-top:1px solid #e5e7eb;">
                            <p style="margin:0 0 8px;color:#6b7280;font-size:13px;line-height:1.5;">
                                ${footerNote || 'Thank you for trading with us.'}
                            </p>
                            <p style="margin:8px 0 0;color:#9ca3af;font-size:12px;">
                                © ${year} ${siteName} · All rights reserved
                            </p>
                            <p style="margin:16px 0 0;">
                                <a href="${siteUrl}" style="color:#8b5cf6;text-decoration:none;font-size:13px;">Visit Website</a>
                            </p>
                        </td>
                    </tr>
                    
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;
};

// GET /messages — User inbox
// GET /messages
router.get('/', ensureAuthenticated, async (req, res) => {
    try {
        const [messages] = await db.execute(`
            SELECT 
                m.*,
                a.username as admin_username,
                (SELECT COUNT(*) FROM user_messages WHERE parent_id = m.id AND is_from_admin = FALSE) as reply_count
            FROM user_messages m
            JOIN users a ON m.admin_id = a.id
            WHERE m.user_id = ? AND m.parent_id IS NULL
            ORDER BY 
                CASE WHEN m.status = 'unread' THEN 0 ELSE 1 END,
                m.created_at DESC
        `, [req.session.user.id]);

        const [[{ unread }]] = await db.execute(`
            SELECT COUNT(*) as unread 
            FROM user_messages 
            WHERE user_id = ? AND status = 'unread' AND is_from_admin = TRUE
        `, [req.session.user.id]);

        res.render('dashboard/messages', {
            title:       'My Messages',
            messages,
            unreadCount: unread,
            user:        req.session.user
        });
    } catch (error) {
        console.error('User messages error:', error);
        req.flash('error', 'Failed to load messages');
        res.redirect('/dashboard');
    }
});

// GET /messages/:id
router.get('/:id', ensureAuthenticated, async (req, res) => {
    try {
        const messageId = req.params.id;

        const [messages] = await db.execute(`
            SELECT m.*, a.username as admin_username
            FROM user_messages m
            JOIN users a ON m.admin_id = a.id
            WHERE m.id = ? AND m.user_id = ?
        `, [messageId, req.session.user.id]);

        if (messages.length === 0) {
            req.flash('error', 'Message not found');
            return res.redirect('/messages');
        }

        const [replies] = await db.execute(`
            SELECT m.*, 
                CASE WHEN m.is_from_admin THEN a.username ELSE u.username END as sender_name
            FROM user_messages m
            JOIN users u ON m.user_id = u.id
            JOIN users a ON m.admin_id = a.id
            WHERE m.parent_id = ?
            ORDER BY m.created_at ASC
        `, [messageId]);

        await db.execute(
            "UPDATE user_messages SET status = 'read' WHERE id = ? AND user_id = ?",
            [messageId, req.session.user.id]
        );

        const [[{ unread }]] = await db.execute(`
            SELECT COUNT(*) as unread 
            FROM user_messages 
            WHERE user_id = ? AND status = 'unread' AND is_from_admin = TRUE
        `, [req.session.user.id]);

        res.render('dashboard/message_detail', {
            title:       messages[0].subject,
            message:     messages[0],
            replies,
            user:        req.session.user,
            unreadCount: unread
        });
    } catch (error) {
        console.error('Message detail error:', error);
        req.flash('error', 'Failed to load message');
        res.redirect('/messages');
    }
});

// POST /messages/:id/reply
router.post('/:id/reply', ensureAuthenticated, async (req, res) => {
    try {
        const messageId      = req.params.id;
        const { reply_message } = req.body;

        const [parents] = await db.execute(
            'SELECT admin_id, user_id, subject FROM user_messages WHERE id = ?',
            [messageId]
        );

        if (parents.length === 0 || parents[0].user_id !== req.session.user.id) {
            req.flash('error', 'Message not found');
            return res.redirect('/messages');
        }

        await db.execute(`
            INSERT INTO user_messages 
            (user_id, admin_id, type, subject, message, parent_id, is_from_admin, status, created_at)
            VALUES (?, ?, 'reply', ?, ?, ?, FALSE, 'unread', NOW())
        `, [
            req.session.user.id,
            parents[0].admin_id,
            `Re: ${parents[0].subject}`,
            reply_message,
            messageId
        ]);

        await db.execute(
            "UPDATE user_messages SET status = 'replied' WHERE id = ?",
            [messageId]
        );

        const baseUrl = `${req.protocol}://${req.get('host')}`;

        await telegramBot.sendMessage(`
🔔 <b>New User Reply</b>
👤 <b>User:</b> ${req.session.user.username}
📧 <b>Subject:</b> ${parents[0].subject}
💬 <b>Preview:</b> ${reply_message.substring(0, 100)}
🔗 <a href="${baseUrl}/admin/messages/user/${req.session.user.id}">View Conversation</a>
        `.trim());

        req.flash('success', 'Reply sent successfully');
        res.redirect(`/messages/${messageId}`);
    } catch (error) {
        console.error('Reply error:', error);
        req.flash('error', 'Failed to send reply');
        res.redirect(`/messages/${req.params.id}`);
    }
});

module.exports = router;
