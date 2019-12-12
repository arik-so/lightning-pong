import Bigi = require('bigi');
import debugModule = require('debug');
import ecurve = require('ecurve');
import * as crypto from 'crypto';
import {Point} from 'ecurve';
import * as net from 'net';
import {Socket} from 'net';
import {Role, TransmissionHandler} from 'bolt08';
import Handshake from 'bolt08/src/handshake';
import {LightningMessage, Message} from 'bolt02';
import {QueryShortChannelIdsMessage} from 'bolt02/src/messages/query_short_channel_ids';

const debug = debugModule('lightning-pong:tcp');
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

	private channelGraph: object;

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

	public send(message: LightningMessage) {
		if (!this.transmissionHandler) {
			throw new Error('handshake not complete yet');
		}

		const messageBuffer = message.toBuffer();
		const ciphertext = this.transmissionHandler.send(messageBuffer);

		console.log('Sending message of type:', message.getTypeName(), `(${message.getType()})`);
		console.log(messageBuffer.toString('hex'), '\n');
		this.socket.write(ciphertext);
	}

	private processIncomingData(data: Buffer) {
		// there is some unprocessed data that we will prepend to the newly received data for processing
		const inputData = Buffer.concat([this.pendingData, data]);
		this.pendingData = TCP.ZERO_BUFFER;

		// console.log('Processing:');
		// console.log(inputData.toString('hex'), '\n');

		if (this.transmissionHandler instanceof TransmissionHandler) {
			debug('Decrypting');
			const decryptionResult = this.transmissionHandler.receive(inputData);
			this.pendingData = decryptionResult.unreadBuffer;
			const decryptedResponse = decryptionResult.message;

			if (!decryptedResponse || decryptedResponse.length === 0) {
				console.log('Too short too decrypt');
				return;
			}

			console.log('Decrypted:');
			console.log(decryptedResponse.toString('hex'));

			// parse the lightning message
			const lightningMessage = LightningMessage.parse(decryptedResponse);
			console.log('Decoded Lightning message of type:', lightningMessage.getTypeName(), `(${lightningMessage.getType()})\n`);

			if (lightningMessage instanceof Message.InitMessage) {
				const encryptedResponse = this.transmissionHandler.send(decryptedResponse);
				console.log('Sending init message:', decryptedResponse.toString('hex'));
				this.socket.write(encryptedResponse);
			}

			if (lightningMessage instanceof Message.PingMessage) {
				const values = lightningMessage['values'];
				const pongMessage = new Message.PongMessage({
					ignored: Buffer.alloc(values.num_pong_bytes)
				});
				console.log('Sending pong message:', pongMessage.toBuffer().toString('hex'));
				const encryptedResponse = this.transmissionHandler.send(pongMessage.toBuffer());
				this.socket.write(encryptedResponse);
			}

			if (lightningMessage instanceof Message.ReplyChannelRangeMessage) {
				const values = lightningMessage['values'];
				const channelIds = lightningMessage.shortChannelIds.map(id => id.toString('hex'));

				// we need to query the channel stuff
				const queryShortIdsMessage = new QueryShortChannelIdsMessage({
					chain_hash: values.chain_hash,
					encoded_short_ids: values.encoded_short_ids,
					query_short_channel_ids_tlvs: []
				});

				console.log('Received channel ID count:', channelIds.length);
				console.log('Channel IDs:\n', JSON.stringify(channelIds, null, 4));

				// start building channel graph
				this.channelGraph = {};

				this.send(queryShortIdsMessage);
			}

			if (lightningMessage instanceof Message.ChannelAnnouncementMessage) {

				if (this.channelGraph) {
					const values = lightningMessage['values'];
					const node1 = values.node_id_1.getEncoded(true).toString('hex');
					const node2 = values.node_id_2.getEncoded(true).toString('hex');
					const nodes = [node1, node2].sort();
					const channelId = values.short_channel_id.toString('hex');
					this.channelGraph[nodes[0]] = this.channelGraph[nodes[0]] || {};
					this.channelGraph[nodes[0]][nodes[1]] = this.channelGraph[nodes[0]][nodes[1]] || [];
					this.channelGraph[nodes[0]][nodes[1]].push(channelId);
				}

			}

			if (lightningMessage instanceof Message.ReplyShortChannelIdsEndMessage) {
				console.log('Complete:', lightningMessage['values'].complete);
				console.log('Graph:\n', JSON.stringify(this.channelGraph, null, 4));
				this.channelGraph = null;
			}

			if (decryptionResult.unreadBuffer.length > 0) {
				this.processIncomingData(TCP.ZERO_BUFFER);
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

	static async startServer(port: number): Promise<TCP> {
		return new Promise<TCP>((resolve, reject) => {
			console.log('Listening on port:', port);

			const privateKey = crypto.randomBytes(32);
			const publicKey = secp256k1.G.multiply(Bigi.fromBuffer(privateKey)).getEncoded(true);
			console.log('Public key:', publicKey.toString('hex'));

			const server = net.createServer(function (client) {
				const tcp = new TCP(client, Role.RECEIVER, privateKey);
				resolve(tcp);
			});

			server.listen(port);
		});
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
