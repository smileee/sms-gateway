const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

const portPath = '/dev/ttyUSB3'; // Troque para o caminho correto!
const baudRate = 115200;

try {
  const port = new SerialPort({ path: portPath, baudRate });
  const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

  parser.on('data', line => console.log('[MODEM]', line));

  function sendSms(number, message) {
    return new Promise((resolve, reject) => {
      port.write('AT+CMGF=1\r');
      setTimeout(() => {
        port.write(`AT+CMGS="${number}"\r`);
        setTimeout(() => {
          port.write(message);
          port.write(String.fromCharCode(26)); // Ctrl+Z
          resolve('Mensagem enviada');
        }, 1000);
      }, 500);
    });
  }

  sendSms('+17743010298', 'Hello from Node.js via SIM7600!')
    .then(console.log)
    .catch(console.error);

} catch (err) {
  console.error('Erro ao abrir porta serial:', err.message);
}