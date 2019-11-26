import Bigi = require('bigi');
import debugModule = require('debug');
import ecurve = require('ecurve');
import * as crypto from 'crypto';
import {Point} from 'ecurve';
import * as net from 'net';
import {Socket} from 'net';
import {Role, TransmissionHandler} from 'bolt08';
import Handshake from 'bolt08/src/handshake';
import {LightningMessage} from 'bolt02';
import {InitMessage} from 'bolt02/src/messages/init';
import {PingMessage} from 'bolt02/src/messages/ping';
import {PongMessage} from 'bolt02/src/messages/pong';

const debug = debugModule('bolt08:handshake');
const secp256k1 = ecurve.getCurveByName('secp256k1');

export default class TCP {

	static readonly ZERO_BUFFER = Buffer.alloc(0);

	private readonly privateKey: Buffer;
	private readonly publicKey: Buffer;
	private readonly socket: Socket;

	private pendingData: Buffer;
	private role: Role;
	private handshakeHandler: Handshake;
	private transmissionHandler: TransmissionHandler;

	constructor(socket: Socket, role: Role, privateKey?: Buffer) {
		this.privateKey = privateKey || crypto.randomBytes(32);
		this.publicKey = secp256k1.G.multiply(Bigi.fromBuffer(this.privateKey)).getEncoded(true);

		this.socket = socket;
		this.role = role;

		this.pendingData = TCP.ZERO_BUFFER;
		this.handshakeHandler = new Handshake({privateKey: this.privateKey});

		this.socket.on('data', (data) => {
			console.log('Received:');
			console.log(data.toString('hex'), '\n');
			this.processIncomingData(data);
		});

		this.socket.on('error', (error) => {
			console.log('Error:');
			console.log(error);
		});

		this.socket.on('close', function () {
			console.log('Connection closed');
		});
	}

	private processIncomingData(data: Buffer) {
		// there is some unprocessed data that we will prepend to the newly received data for processing
		const inputData = Buffer.concat([this.pendingData, data]);
		this.pendingData = TCP.ZERO_BUFFER;

		console.log('Processing:');
		console.log(inputData.toString('hex'), '\n');

		if (this.transmissionHandler instanceof TransmissionHandler) {
			const decryptedResponse = this.transmissionHandler.receive(inputData);
			console.log('Decrypted:');
			console.log(decryptedResponse.toString('hex'), '\n');

			// parse the lightning message
			const lightningMessage = LightningMessage.parse(decryptedResponse);
			console.log('Decoded Lightning message of type:', lightningMessage.getTypeName(), `(${lightningMessage.getType()})`);

			if (lightningMessage instanceof InitMessage) {
				const encryptedResponse = this.transmissionHandler.send(decryptedResponse);
				console.log('Sending init message:', decryptedResponse.toString('hex'));
				this.socket.write(encryptedResponse);
			}

			if (lightningMessage instanceof PingMessage) {
				const values = lightningMessage['values'];
				const pongMessage = new PongMessage({
					ignored: Buffer.alloc(values.num_pong_bytes)
				});
				console.log('Sending pong message:', pongMessage.toBuffer().toString('hex'));
				const encryptedResponse = this.transmissionHandler.send(pongMessage.toBuffer());
				this.socket.write(encryptedResponse);
			}

		} else {
			const output = this.handshakeHandler.actDynamically({role: this.role, incomingBuffer: inputData});
			if (output.responseBuffer && output.responseBuffer.length > 0) {
				const response = output.responseBuffer;

				console.log('Responding:');
				console.log(response.toString('hex'), '\n');
				this.socket.write(response)
			}
			if (output.transmissionHandler && output.transmissionHandler instanceof TransmissionHandler) {
				this.transmissionHandler = output.transmissionHandler;
			}
			if (output.unreadBuffer && output.unreadBuffer.length > 0) {
				this.pendingData = output.unreadBuffer;
				// let's immediately process the remaining data in this case
				this.processIncomingData(TCP.ZERO_BUFFER);
			}
		}
	}

	static startServer(port: number) {
		console.log('Listening on port:', port);

		const privateKey = crypto.randomBytes(32);
		const publicKey = secp256k1.G.multiply(Bigi.fromBuffer(privateKey)).getEncoded(true);
		console.log('Public key:', publicKey.toString('hex'));

		const server = net.createServer(function (client) {
			const tcp = new TCP(client, Role.RECEIVER, privateKey);
		});

		server.listen(port);
	}

	static startClient(urlString: string): TCP {
		const components = urlString.split('@');
		const publicKey = components[0];
		if (publicKey.length !== 66) {
			throw new Error('public key must be 33 bytes');
		}
		const publicKeyBuffer = Buffer.from(publicKey, 'hex');
		const publicKeyPoint: Point = Point.decodeFrom(secp256k1, publicKeyBuffer);
		// make sure it's not on infinity or some shit

		const host = components[1];
		const hostComponents = host.split(':');
		const domain = hostComponents[0];
		const port = parseInt(hostComponents[1]);

		const client = new net.Socket();
		const tcp = new TCP(client, Role.INITIATOR);

		console.log('Connecting to:', urlString);

		client.connect(port, domain, () => {
			const firstActOutput = tcp.handshakeHandler.actDynamically({
				role: Role.INITIATOR,
				remotePublicKey: publicKeyBuffer
			});
			const firstMessage = firstActOutput.responseBuffer;
			console.log('First message:');
			console.log(firstMessage.toString('hex'), '\n');
			client.write(firstMessage);
		});

		return tcp;
	}

}
