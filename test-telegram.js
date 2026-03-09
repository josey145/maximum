require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

console.log('Token:', token);
console.log('Chat ID:', chatId);

const bot = new TelegramBot(token, { polling: false });

bot.getMe()
    .then((info) => {
        console.log('✅ Bot working! Username:', info.username);
        
        // Try sending message
        return bot.sendMessage(chatId, '🔔 Test message from Maximum Crypto Platform');
    })
    .then((result) => {
        console.log('✅ Message sent! Message ID:', result.message_id);
        process.exit(0);
    })
    .catch((err) => {
        console.error('❌ Error:', err.message);
        process.exit(1);
    });