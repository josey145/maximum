const TelegramBot = require('node-telegram-bot-api');

// Second bot for signals and PUBLIC notifications to clients
const SIGNAL_BOT_TOKEN = process.env.SIGNAL_BOT_TOKEN;
const SIGNAL_CHANNEL_ID = process.env.SIGNAL_CHANNEL_ID;

let bot = null;

if (SIGNAL_BOT_TOKEN) {
    try {
        bot = new TelegramBot(SIGNAL_BOT_TOKEN, { polling: false });
        console.log('✅ Signal bot initialized for client notifications');
    } catch (err) {
        console.error('❌ Signal bot init failed:', err.message);
    }
} else {
    console.log('⚠️ Signal bot not configured');
}

module.exports = {
    isConfigured: () => !!bot && !!SIGNAL_CHANNEL_ID,
    
    // Send trading signal to PUBLIC channel (clients)
    sendSignal: async (signalData) => {
        if (!bot || !SIGNAL_CHANNEL_ID) {
            console.log('Signal bot not configured');
            return null;
        }
        
        try {
            const message = `
📊 <b>NEW TRADING SIGNAL #${signalData.id}</b>

💱 <b>Pair:</b> ${signalData.pair}
📈 <b>Direction:</b> ${signalData.direction.toUpperCase()}
💰 <b>Entry:</b> ${signalData.entry_price}
🎯 <b>Target:</b> ${signalData.target_price}
🛡 <b>Stop Loss:</b> ${signalData.stop_loss}
⚡ <b>Leverage:</b> ${signalData.leverage}x

⏱ <b>Time:</b> ${new Date().toLocaleString()}

⚠️ <b>Risk Warning:</b> Trade at your own risk.

🤖 <i>Maximum Trading Bot</i>
            `;
            
            const sent = await bot.sendMessage(SIGNAL_CHANNEL_ID, message, { 
                parse_mode: 'HTML',
                disable_web_page_preview: true 
            });
            
            console.log('✅ Trading signal sent to clients');
            return sent.message_id;
        } catch (err) {
            console.error('❌ Failed to send signal:', err.message);
            return null;
        }
    },
    
    // Update signal result in public channel
    updateSignalResult: async (signalId, result, pair) => {
        if (!bot || !SIGNAL_CHANNEL_ID) return;
        
        try {
            const emoji = result === 'win' ? '✅' : '❌';
            const text = result === 'win' ? 'TARGET HIT! 🎯' : 'STOP LOSS HIT 🛡';
            
            const message = `
${emoji} <b>SIGNAL #${signalId} CLOSED - ${text}</b>

💱 <b>Pair:</b> ${pair}
📊 <b>Result:</b> ${result.toUpperCase()}
⏱ <b>Closed:</b> ${new Date().toLocaleString()}
            `;
            
            await bot.sendMessage(SIGNAL_CHANNEL_ID, message, { parse_mode: 'HTML' });
            console.log('✅ Signal result updated');
        } catch (err) {
            console.error('❌ Failed to update signal:', err.message);
        }
    },
    
    // Send withdrawal code TO CLIENT (public channel or DM)
    notifyWithdrawCodeToClient: async (username, code, expires) => {
        if (!bot || !SIGNAL_CHANNEL_ID) {
            console.log('Signal bot not configured for client notification');
            return;
        }
        
        try {
            // This sends to a public channel - be careful with sensitive data!
            // Better to send DM or use a private client channel
            const message = `
🔐 <b>Withdrawal Code Ready</b>

👤 <b>User:</b> ${username}
⏰ <b>Expires:</b> ${new Date(expires).toLocaleString()}

<i>Contact admin to receive your secure code.</i>
            `;
            
            await bot.sendMessage(SIGNAL_CHANNEL_ID, message, { parse_mode: 'HTML' });
            console.log('✅ Client withdrawal notification sent');
        } catch (err) {
            console.error('❌ Failed to notify client:', err.message);
        }
    }
};