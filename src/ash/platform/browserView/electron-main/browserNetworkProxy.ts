import { createServer, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import type { IChannel } from '../../../base/parts/ipc/common/ipc.js';
import type { IBrowserViewNetwork, IBrowserViewNetworkProxyProvider } from '../common/browserView.js';

/** Native SOCKS framing only. The renderer routes bytes; the shared backend owns DNS and outbound sockets. */
export class BrowserNetworkProxy implements IBrowserViewNetworkProxyProvider {
	constructor(private readonly channel: IChannel, private readonly network: IBrowserViewNetwork) { }
	public async openProxy(signal: AbortSignal): Promise<IDisposable & { localPort: number; signal: AbortSignal; }> {
		await this.channel.call('probe', { network: this.network });
		signal.throwIfAborted();
		const cancellation = new AbortController();
		const sockets = new Set<Socket>();
		const server = createServer({ allowHalfOpen: true }, socket => {
			if (sockets.size >= 64 || cancellation.signal.aborted) { socket.destroy(); return; }
			sockets.add(socket);
			socket.on('error', () => { });
			void this.serve(socket, cancellation.signal).catch(() => socket.destroy()).finally(() => sockets.delete(socket));
		});
		const lease = toDisposable(() => {
			cancellation.abort();
			signal.removeEventListener('abort', stop);
			server.close();
			for (const socket of sockets) { socket.destroy(); }
		});
		const stop = (): void => lease.dispose();
		signal.addEventListener('abort', stop, { once: true });
		try {
			await new Promise<void>((resolve, reject) => {
				server.once('error', reject);
				server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
			});
			signal.throwIfAborted();
			const address = server.address();
			if (!address || typeof address === 'string') { throw new Error('Browser proxy unavailable'); }
			return Object.assign(lease, { localPort: address.port, signal: cancellation.signal });
		} catch (error) { lease.dispose(); throw error; }
	}

	private async serve(socket: Socket, signal: AbortSignal): Promise<void> {
		const id = randomUUID();
		const iterator = socket[Symbol.asyncIterator]();
		let pending = Buffer.alloc(0);
		const take = async (count: number): Promise<Buffer> => {
			while (pending.length < count) {
				const next = await iterator.next();
				if (next.done) { throw new Error('SOCKS handshake closed'); }
				pending = Buffer.concat([pending, next.value]);
				if (pending.length > 131072) { throw new Error('SOCKS handshake too large'); }
			}
			const value = pending.subarray(0, count); pending = pending.subarray(count); return value;
		};
		socket.setTimeout(10000, () => socket.destroy());
		let opened = false;
		try {
			const greeting = await take(2);
			if (greeting[0] !== 5 || !(await take(greeting[1]!)).includes(0)) { throw new Error('Unsupported SOCKS authentication'); }
			socket.write(Buffer.from([5, 0]));
			const header = await take(4);
			if (header[0] !== 5 || header[1] !== 1 || header[2] !== 0) { throw new Error('Unsupported SOCKS command'); }
			let host: string;
			if (header[3] === 3) { host = (await take((await take(1))[0]!)).toString('utf8'); }
			else if (header[3] === 1) { host = [...await take(4)].join('.'); }
			else if (header[3] === 4) { const bytes = await take(16); host = '[' + Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(i * 2).toString(16)).join(':') + ']'; }
			else { throw new Error('Unsupported SOCKS address'); }
			const port = (await take(2)).readUInt16BE();
			await this.channel.call('open', { id, network: this.network, host, port });
			opened = true;
			if (socket.destroyed) { return; }
			socket.setTimeout(0);
			socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
			const upload = async (bytes: Uint8Array): Promise<void> => {
				for (let offset = 0; offset < bytes.length;) {
					signal.throwIfAborted();
					const written = await this.channel.call<number>('write', { id, dataBase64: Buffer.from(bytes.subarray(offset, Math.min(offset + 65536, bytes.length))).toString('base64') });
					if (!Number.isInteger(written) || written < 0 || written > Math.min(65536, bytes.length - offset)) { throw new Error('Invalid TCP write acknowledgement'); }
					offset += written;
					if (!written) { await delay(10, undefined, { signal }); }
				}
			};
			await Promise.all([
				(async () => {
					await upload(pending);
					for (let item = await iterator.next(); !item.done; item = await iterator.next()) { await upload(item.value); }
					await this.channel.call('end', { id });
				})(),
				(async () => {
					while (!socket.destroyed) {
						signal.throwIfAborted();
						const result = await this.channel.call<{ dataBase64: string; eof: boolean; }>('read', { id });
						if (typeof result.dataBase64 !== 'string' || result.dataBase64.length > 87384 || typeof result.eof !== 'boolean') { throw new Error('Invalid TCP read'); }
						const bytes = Buffer.from(result.dataBase64, 'base64');
						if (bytes.length > 65536 || bytes.toString('base64') !== result.dataBase64) { throw new Error('Invalid TCP chunk'); }
						if (bytes.length) { await new Promise<void>((resolve, reject) => socket.write(bytes, error => error ? reject(error) : resolve())); }
						if (result.eof) { socket.end(); return; }
						if (!bytes.length) { await delay(20, undefined, { signal }); }
					}
				})(),
			]);
		} finally {
			socket.destroy();
			if (opened) { await this.channel.call('close', { id }).catch(() => { }); }
		}
	}
}
