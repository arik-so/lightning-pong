#!/usr/bin/env node

import {ArgumentParser} from 'argparse';
import * as inquirer from 'inquirer';
import TCP from './src/tcp';
import {PingMessage} from 'bolt02/src/messages/ping';
import * as crypto from 'crypto';
import * as rp from 'request-promise-native';
import {QueryChannelRangeMessage} from 'bolt02/src/messages/query_channel_range';

const parser = new ArgumentParser({
	addHelp: true,
	description: 'Lightning Pong'
});

const subparsers = parser.addSubparsers({
	dest: 'mode'
});

const serverParser = subparsers.addParser('listen', {
	addHelp: true,
	description: 'Wait for incoming connection'
});

const clientParser = subparsers.addParser('connect', {
	addHelp: true,
	description: 'Connect to existing LND node'
});

clientParser.addArgument([], {
	action: 'store',
	dest: 'url'
});

serverParser.addArgument(['-p', '--port'], {
	dest: 'port',
	type: 'int',
	required: true,
	help: 'Port to listen for incoming connections on'
});

const args = parser.parseArgs();

(async () => {
	let tcp: TCP;
	if (args.mode === 'listen') {
		tcp = await TCP.startServer(args.port);
	} else if (args.mode === 'connect') {
		tcp = TCP.startClient(args.url);
	}

	// gotta wait for a bit
	await new Promise(resolve => setTimeout(resolve, 1000));

	while (true) {

		console.log('\n');
		const input = await inquirer.prompt([{
			type: 'rawlist',
			name: 'action',
			message: 'What would you like to do?',
			choices: [
				{name: 'Ping', value: 'ping'},
				{name: 'Open Channel', value: 'open-channel'},
				{name: 'Query Graph', value: 'query-graph'}
			]
		}]);
		console.log('\n');

		if (input.action === 'ping') {
			const minLength = 5;
			const maxLength = 30;
			const requestLength = crypto.randomBytes(1).readUInt8(0) % (maxLength - minLength + 1) + minLength;
			const responseLength = crypto.randomBytes(1).readUInt8(0) % (maxLength - minLength + 1) + minLength;
			const pingMessage = new PingMessage({
				ignored: Buffer.alloc(requestLength, 0),
				num_pong_bytes: responseLength
			});
			tcp.send(pingMessage);
		}

		const TESTNET_GENESIS_HASH = '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943';
		// const LOCAL_REGTEST_GENESIS_HASH = '06226e46111a0b59caaf126043eb5bbf28c34f3a5e332a1fc7b2b73cf188910f';

		if (input.action === 'query-graph') {
			const chainHash = Buffer.from(TESTNET_GENESIS_HASH, 'hex').reverse();
			const chainStatus = await rp({uri: 'https://test.bitgo.com/api/v2/tbtc/public/block/latest', json: true});
			const latestBlock = chainStatus.height;
			const queryMessage = new QueryChannelRangeMessage({
				first_blocknum: latestBlock - 50,
				number_of_blocks: 100,
				chain_hash: chainHash,
				query_channel_range_tlvs: []
			});
			tcp.send(queryMessage);
		}

		await new Promise(resolve => setTimeout(resolve, 250));

	}
})();
