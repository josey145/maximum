const axios = require('axios');

let priceHistory = [];
const MAX_HISTORY = 50;
let lastPrice = 45000; // Starting price for mock data

const priceSocket = (io) => {
    io.on('connection', (socket) => {
        console.log('Client connected:', socket.id);
        
        if (priceHistory.length > 0) {
            socket.emit('priceHistory', priceHistory);
        }
        
        socket.on('disconnect', () => {
            console.log('Client disconnected:', socket.id);
        });
    });

    const fetchBitcoinPrice = async () => {
        try {
            const response = await axios.get(
                'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true',
                { timeout: 5000 }
            );
            
            const data = {
                price: response.data.bitcoin.usd,
                change24h: response.data.bitcoin.usd_24h_change,
                timestamp: new Date()
            };

            updatePriceHistory(data);
            io.emit('btcPrice', data);
            console.log('Price updated:', data.price);
        } catch (error) {
            // Use mock data when API fails
            console.log('API failed, using mock data');
            const mockChange = (Math.random() - 0.5) * 200;
            lastPrice += mockChange;
            
            const mockData = {
                price: lastPrice,
                change24h: (Math.random() - 0.5) * 5,
                timestamp: new Date()
            };
            
            updatePriceHistory(mockData);
            io.emit('btcPrice', mockData);
        }
    };

    const updatePriceHistory = (data) => {
        priceHistory.push(data);
        if (priceHistory.length > MAX_HISTORY) {
            priceHistory.shift();
        }
    };

    // Initial fetch
    fetchBitcoinPrice();
    
    // Set interval to 60 seconds to reduce API calls
    setInterval(fetchBitcoinPrice, 60000);
};

module.exports = priceSocket;