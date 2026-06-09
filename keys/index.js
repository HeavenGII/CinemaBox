if (process.env.NODE_ENV === `production`){
    module.exports = require('./keys.prod')
} else {
    module.exports = require('./keys.dev')
}

const net = require('net');
function testPort(host, port) {
    const socket = new net.Socket();
    socket.setTimeout(5000);
    socket.connect(port, host, () => {
        console.log(`✅ Порт ${port} на ${host} ДОСТУПЕН`);
        socket.destroy();
    });
    socket.on('timeout', () => {
        console.log(`❌ Таймаут ${port} на ${host}`);
        socket.destroy();
    });
    socket.on('error', (err) => {
        console.log(`❌ Ошибка ${port} на ${host}: ${err.message}`);
    });
}
testPort('smtp.mail.ru', 465);
testPort('smtp.mail.ru', 587);
testPort('smtp.gmail.com', 587);