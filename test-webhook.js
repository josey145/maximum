const axios = require('axios');

// Configuration
const LOCAL_URL = 'http://localhost:3000/webhook/tradingview';
const NGROK_URL = 'https://choreal-pseudoregal-wynona.ngrok-free.dev/webhook/tradingview';

// Use ngrok URL if available, otherwise localhost
const WEBHOOK_URL = process.env.USE_NGROK ? NGROK_URL : LOCAL_URL;

console.log('🚀 Webhook Test Client');
console.log('Target URL:', WEBHOOK_URL);
console.log('');

// Test data - simulated forex prices
const testPairs = [
    { symbol: 'EURUSD', baseBid: 1.08500, baseAsk: 1.08520 },
    { symbol: 'GBPUSD', baseBid: 1.26500, baseAsk: 1.26530 },
    { symbol: 'USDJPY', baseBid: 149.500, baseAsk: 149.520 },
    { symbol: 'USDCHF', baseBid: 0.90200, baseAsk: 0.90220 },
    { symbol: 'XAUUSD', baseBid: 2035.50, baseAsk: 2036.00 }
];

let isRunning = false;

// Send single test alert
async function sendTestAlert(pair, movement = 0) {
    try {
        const bid = pair.baseBid * (1 + movement);
        const ask = pair.baseAsk * (1 + movement);
        
        const payload = {
            secret: process.env.WEBHOOK_SECRET || 'your_webhook_secret',
            symbol: pair.symbol,
            price: {
                bid: Math.round(bid * 100000) / 100000,
                ask: Math.round(ask * 100000) / 100000
            },
            timestamp: new Date().toISOString()
        };

        const response = await axios.post(WEBHOOK_URL, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 5000
        });

        console.log(`✅ ${pair.symbol} @ ${payload.price.bid} | Response:`, response.data.success ? 'OK' : 'FAIL');
        return true;
        
    } catch (error) {
        console.error(`❌ ${pair.symbol} failed:`, error.message);
        if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Data:', error.response.data);
        }
        return false;
    }
}

// Run continuous simulation
async function startSimulation() {
    if (isRunning) return;
    isRunning = true;
    
    console.log('▶️  Starting continuous price simulation...');
    console.log('Press Ctrl+C to stop\n');
    
    let iteration = 0;
    
    while (isRunning) {
        iteration++;
        console.log(`\n--- Update #${iteration} ---`);
        
        for (const pair of testPairs) {
            // Random movement between -0.05% and +0.05%
            const movement = (Math.random() - 0.5) * 0.001;
            await sendTestAlert(pair, movement);
            
            // Small delay between pairs
            await sleep(100);
        }
        
        // Wait 3 seconds between updates
        await sleep(3000);
    }
}

// Run single test for all pairs
async function runSingleTest() {
    console.log('🧪 Running single test for all pairs...\n');
    
    let passed = 0;
    let failed = 0;
    
    for (const pair of testPairs) {
        const success = await sendTestAlert(pair);
        success ? passed++ : failed++;
        await sleep(200);
    }
    
    console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

// Utility: sleep
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\n🛑 Stopping...');
    isRunning = false;
    process.exit(0);
});

// Main execution
const command = process.argv[2];

switch (command) {
    case 'simulate':
    case 's':
        startSimulation();
        break;
        
    case 'once':
    case 'o':
        runSingleTest();
        break;
        
    default:
        console.log(`
Usage: node test-webhook.js [command]

Commands:
  simulate, s    - Run continuous price simulation (default)
  once, o        - Run single test and exit
  
Environment:
  USE_NGROK=1    - Use ngrok URL instead of localhost
  WEBHOOK_SECRET - Set custom webhook secret

Examples:
  node test-webhook.js
  node test-webhook.js once
  USE_NGROK=1 node test-webhook.js simulate
        `);
        startSimulation(); // Default to simulation
}