import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import models from './dictation.json' with { type: 'json' };
import graphs from './graphs.json' with { type: 'json' };

function varint(value: number): number[] {
	const bytes: number[] = [];
	while (value >= 128) {
		bytes.push((value % 128) + 128);
		value = Math.floor(value / 128);
	}
	bytes.push(value);
	return bytes;
}

function createFiles(total: number, transcript: string): ReadonlyMap<string, Buffer> {
	const encoder = gunzipSync(Buffer.from(graphs.encoder, 'base64'));
	const decoder = gunzipSync(Buffer.from(graphs.decoder, 'base64'));
	const tokens = Buffer.from(JSON.stringify(['<blank>', transcript, ...Array.from({ length: 8402 }, (_, i) => `<fixture-${i + 2}>`)]));
	const cmvn = Buffer.from(`<AddShift> 560 560\n<LearnRateCoef> 0 [ ${Array(560).fill('0').join(' ')} ]\n<Rescale> 560 560\n<LearnRateCoef> 0 [ ${Array(560).fill('1').join(' ')} ]\n`);
	// ModelProto field 6 is doc_string. Padding makes the transfer observable without changing inference.
	const padding = total - encoder.length - decoder.length - tokens.length - cmvn.length - 5;
	const paddedEncoder = Buffer.concat([encoder, Buffer.from([0x32, ...varint(padding)]), Buffer.alloc(padding, 0x78)]);
	const files = new Map([['encoder.onnx', paddedEncoder], ['decoder.onnx', decoder], ['tokens.json', tokens], ['am.mvn', cmvn]]);
	if ([...files.values()].reduce((size, bytes) => size + bytes.length, 0) !== total) {
		throw new Error('Unexpected dictation fixture size');
	}
	return files;
}

function verifyFiles(manifest: typeof models[number], files: ReadonlyMap<string, Buffer>): void {
	for (const entry of Object.values(manifest.files)) {
		const bytes = files.get(entry.name);
		const actual = bytes && { name: entry.name, size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
		if (!isDeepStrictEqual(actual, entry)) {
			throw new Error(`Dictation fixture file does not match its manifest: ${manifest.id}/${entry.name}`);
		}
	}
}

export async function startDictationFixtureServer(failFirstDownload = false): Promise<Server> {
	const endpoint = new URL(models[0].base_url);
	const port = Number(endpoint.port);
	if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || port === 0) {
		throw new Error('Dictation fixture downloads require a loopback HTTP address with an explicit port');
	}
	const transcripts: Readonly<Record<string, string>> = graphs.transcripts;
	const files = new Map(models.flatMap(manifest => {
		const url = new URL(manifest.base_url);
		if (url.origin !== endpoint.origin) {
			throw new Error(`Dictation fixture ${manifest.id} must use ${endpoint.origin}`);
		}
		const path = url.pathname;
		const transcript = transcripts[path];
		if (transcript === undefined) {
			throw new Error(`No dictation fixture assets for ${path}`);
		}
		const total = Object.values(manifest.files).reduce((size, entry) => size + entry.size_bytes, 0);
		const contents = createFiles(total, transcript);
		verifyFiles(manifest, contents);
		const transfer = { total, started: 0 };
		let offset = 0;
		return [...contents].map(([name, bytes]) => {
			const file = { bytes, offset, transfer };
			offset += bytes.length;
			return [`${path}/${name}`, file] as const;
		});
	}));
	const server = createServer(async (request, response) => {
		const file = request.method === 'GET' && files.get(request.url ?? '');
		if (!file) {
			response.writeHead(404).end();
			return;
		}
		if (file.offset === 0) {
			if (failFirstDownload) {
				failFirstDownload = false;
				response.writeHead(503).end();
				return;
			}
			file.transfer.started = performance.now();
		}
		const { started, total } = file.transfer;
		response.writeHead(200, { 'content-length': file.bytes.length, 'content-type': 'application/octet-stream' });
		for (let position = 0; position < file.bytes.length && !response.destroyed; position += 64 * 1024) {
			const chunk = file.bytes.subarray(position, position + 64 * 1024);
			const target = started + (file.offset + position + chunk.length) / total * 30_000;
			await delay(Math.max(0, target - performance.now()));
			if (!response.destroyed) response.write(chunk);
		}
		if (!response.destroyed) response.end();
	});
	server.listen(port, endpoint.hostname);
	await once(server, 'listening');
	return server;
}
