const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const five = require('johnny-five');
const path = require('path');
const cmd = require('node-cmd');
const Controller = require('node-pid-controller');
const port = 80;
const arduino = new five.Board({ port: 'COM6' });
let setPoint = 30;
let u, e = 0;    // valor de saída e valor do erro  
let therm1, therm2, therm3, therm4, therm5;  // sensores 
let pidInterval, onOffInterval, offInterval; // será usado para armazenar os setIntervals 

// atender requisições com pasta a frontend
app.use(express.static(path.resolve(__dirname + '/../frontend')));
// executar quando o arduino estiver pronto
arduino.on('ready', () => {
	setPins();
	arduino.pinMode(9, five.Pin.PWM);
	startControling('PID');
	setTimeout(() => startSaving(), 100);
	io.on('connection', socket => {
		startSending(socket, socket.id);               // começa a mandar os dados para os clientes
		socket.on('setPins', pins => setPins(pins));      // mudar os canais do Arduino 
		socket.on('changingSetPoint', setPointReceived => setSetPoint(socket, setPointReceived)); // mudar o setpoint 
		socket.on('changingControlMode', modeReceived => setControlMode(modeReceived));  // mudar o modo de controle
		socket.on('plotChart', __ => octavePlot(socket)); // plotagem do gráfico 
	});
	http.listen(port, () => {
		console.log('============ SISTEMA PRONTO ============');
		console.log(`   Abrir em: http://localhost:${port}`);
		console.log('>> ========================================');
	});
});
// interpreta o script draw.m para o Octave gerar a imagem do gráfico 
function octavePlot(socket) {
	// let tryPlot = setInterval(() => {
	cmd.get('octave-cli backend/draw.m', (e, dt) => {
		if (!e) {
			console.log('Gráfico gerado');
			socket.emit('chartReady', null); // confirmar pro cliente que o gráfico está pronto
			// clearInterval(tryPlot);
		} else {
			console.log(e);
		}
	});
	// }, 10);

}
// mudar o modo de controle 
function setControlMode(controlMode) {
	console.log('Modo de controle mudado para ' + controlMode);
	clearInterval(onOffInterval); // limpando todos os controles 
	clearInterval(pidInterval);
	clearInterval(offInterval);
	startControling(controlMode); // iniciando o novo
}
// função para setar novos canais no Arduino 
function setPins(pins = ['A5', 'A4', 'A3', 'A2', 'A1']) {
	therm1 = new five.Sensor({ pin: pins[0], freq: 100 });
	therm2 = new five.Sensor({ pin: pins[1], freq: 100 });
	therm3 = new five.Sensor({ pin: pins[2], freq: 100 });
	therm4 = new five.Sensor({ pin: pins[3], freq: 100 });
	therm5 = new five.Sensor({ pin: pins[4], freq: 100 });
	console.log(`Canais setados: ${pins}`);
}
// comecça a salvar em arquivo txt 
function startSaving() {
	setInterval(() => {
		cmd.run(`echo ${getTemp()},${scale(u, 'to [0,5]')},${e},${setPoint} >> backend/hist.txt`);
	}, 250);
}
// começa a controlar o secador de grãos a partir do modo passado 
function startControling(mode) {
	switch (mode) {
		case 'PID': pidControling(); break;       // controle por pid
		case 'ON/OFF': onOffControling(); break;  // controle por liga/desliga
		case 'Desligado': offControling(); break; // controle desligado, valor constante de 3v
	}
}
// controle desligado, valor constante de 3v
function offControling() {
	u = scale(3);
	offInterval = setInterval(() => {
		arduino.analogWrite(9, scale(3));
	}, 100);
}
// controle por liga/desliga 
function onOffControling() {
	onOffInterval = setInterval(() => {
		if (getTemp() < setPoint) {
			u = 255;
		} else {
			u = 0;
		}
		arduino.analogWrite(9, u);
	}, 100);
}
// controle por pid 
function pidControling() {
	pidInterval = setInterval(() => {
		const KP = 1 / 0.3, KI = KP / 1.27, H = 0.1, KD = KP * 6;
		let control = new Controller(KP, KI, KD, H);
		control.setTarget(setPoint);
		let output = getTemp();
		e = getTemp() - setPoint;
		u = control.update(output);
		if (u < 2 && setPoint > 30)
			u *= 1.05;
		if (u > 255)
			u = 255;
		else if (u < 0)
			u = 0;
		arduino.analogWrite(9, u);
	}, 100);
}
// retorna a temperatura media
function getTemp() {
	return ((toCelsius(therm1.value) + toCelsius(therm2.value) +
		toCelsius(therm3.value) + toCelsius(therm4.value) + toCelsius(therm5.value)) / 5);
}
// mudar o setPoint 
function setSetPoint(socket, newSetPoint) {
	setPoint = Number(newSetPoint); // garantir que será um número
	socket.broadcast.emit('changeSetPoint', setPoint); // enviando para todos clientes exceto o atual 
	console.log(`Set point mudado para ${setPoint}`);
}
// começa a mandar os dados para o arduino
function startSending(socket, clientId) {
	setInterval(() => socket.emit('controlBitValue', scale(u, 'to [0,5]')), 500);
	console.log('Mandando dados para ' + clientId);
	// passar o setPoint atual para o novo usuário conectado
	socket.emit('changeSetPoint', setPoint);
	// quando receber um novo setPoint é necessário mandar o novo set para todos os clientes 
	tempSend(socket, therm1, 'newTemperature1');
	tempSend(socket, therm2, 'newTemperature2');
	tempSend(socket, therm3, 'newTemperature3');
	tempSend(socket, therm4, 'newTemperature4');
	tempSend(socket, therm5, 'newTemperature5');
}
// faz os dados de um termistor começarem a ser mandados pros clientes via socket.io
function tempSend(socket, therm, socketMsg) {
	// setInterval(() => socket.emit(socketMsg, toCelsius(Math.random() * 100 + 420)), 400);
	therm.on('data', () => socket.emit(socketMsg, toCelsius(therm.value)));
}
// converte valor ADC em Celsius
function toCelsius(rawADC) {
	let temp = Math.log(((10240000 / rawADC) - 10000));
	temp = 1 / (0.001129148 + (0.000234125 * temp) + (0.0000000876741 * temp ** 3));
	temp = temp - 273.15;   // Kelvin para Celsius 
	return temp;
}
// retorna correspondente do valor em outra escala  
function scale(value, inverse = false) {
	let from;
	if (!inverse) {
		from = [0, 5], to = [0, 255];
	} else {
		from = [0, 255], to = [0, 5];
	}
	var scale = (to[1] - to[0]) / (from[1] - from[0]);
	var capped = Math.min(from[1], Math.max(from[0], value)) - from[0];
	return (capped * scale + to[0]);
}