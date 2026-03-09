const socket=io();

const priceText=document.getElementById("price");

const ctx=document.getElementById("chart");

const data={
labels:[],
datasets:[{
label:"BTC Price",
data:[]
}]
};

const chart=new Chart(ctx,{
type:"line",
data:data
});

socket.on("btcPrice",(price)=>{

priceText.innerText="$"+price;

data.labels.push(new Date().toLocaleTimeString());
data.datasets[0].data.push(price);

chart.update();

});