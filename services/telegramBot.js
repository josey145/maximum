const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

class TelegramService {
    constructor() {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        this.chatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();
        this.enabled = !!(token && token.length > 20 && token.includes(':') && this.chatId);

        console.log('🔍 TelegramService constructor running...');
        console.log('   TOKEN:', token ? token.substring(0, 10) + '...' : 'UNDEFINED');
        console.log('   CHAT ID:', this.chatId || 'UNDEFINED');
        
        this.enabled = !!(token && token.length > 20 && token.includes(':') && this.chatId);
        console.log('   ENABLED:', this.enabled); // ← THIS IS THE KEY LINE

        if (this.enabled) {
            try {
                this.bot = new TelegramBot(token, { polling: false });
                console.log('✅ Telegram bot initialized (send-only mode)');
            } catch (error) {
                console.error('❌ Telegram init failed:', error.message);
                this.enabled = false;
            }
        } else {
            console.log('⚠️ Telegram bot DISABLED — check .env values');
            console.log('   Token exists:', !!token);
            console.log('   Chat ID:', this.chatId);
        }
    }

    async sendMessage(message) {
        if (!this.enabled) {
            console.log('❌ Telegram disabled, skipping');
            return;
        }
        try {
            // ✅ Use HTML instead of Markdown — underscores in names/emails won't break it
            const result = await this.bot.sendMessage(this.chatId, message, { parse_mode: 'HTML' });
            console.log('✅ Telegram sent! Message ID:', result.message_id);
        } catch (error) {
            console.error('❌ Telegram send failed:', error.code, error.message);
            // ✅ If HTML fails too, retry as plain text
            try {
                await this.bot.sendMessage(this.chatId, message.replace(/<[^>]*>/g, ''));
                console.log('✅ Sent as plain text fallback');
            } catch (e) {
                console.error('❌ Plain text also failed:', e.message);
            }
        }
    }

 

    // Replace just the notifyNewRegistration method in your telegramBot.js with this:

async notifyNewRegistration(userData) {
    console.log('📱 notifyNewRegistration called:', userData.username);
    const message = `
🎉 <b>NEW USER REGISTRATION</b>

👤 Username: ${userData.username}
📧 Email: ${userData.email}
📞 Phone: ${userData.phone || 'N/A'}
🎂 DOB: ${userData.dob || 'N/A'}
💱 Currency: ${userData.currency || 'N/A'}
🆔 User ID: ${userData.userId}

📍 <b>Location</b>
🌍 Country: ${userData.country || 'N/A'}
🗺 State: ${userData.state || 'N/A'}
🏙 City: ${userData.city || 'N/A'}
🏠 Address: ${userData.address || 'N/A'}

🪪 <b>ID Verification</b>
📋 ID Type: ${userData.idType || 'N/A'}
🔢 ID Number: ${userData.idNumber || 'N/A'}
📄 Front: ${userData.idFront || '❌ Not uploaded'}
📄 Back: ${userData.idBack || 'Not provided'}

🌐 IP: ${userData.ip || 'Unknown'}
👥 Total Users: ${userData.totalUsers}
🕐 Time: ${new Date().toLocaleString()}
    `.trim();
    await this.sendMessage(message);
}
}

module.exports = new TelegramService();