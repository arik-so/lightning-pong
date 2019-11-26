#!/usr/bin/env node

import {ArgumentParser} from 'argparse';
import TCP from './src/tcp';

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

if (args.mode === 'listen') {
	TCP.startServer(args.port);
} else if (args.mode === 'connect') {
	TCP.startClient(args.url);
}
