const axios = require("axios");

module.exports = (io) => {

setInterval(async () => {

try {

const res = await axios.get(
"https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
);

io.emit("btcPrice", res.data.bitcoin.usd);

} catch (error) {

console.log("API error, waiting...");

}

}, 15000);

};