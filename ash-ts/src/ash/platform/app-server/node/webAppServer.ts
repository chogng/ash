import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { Server, IncomingMessage } from "node:http";
import type { Http2SecureServer } from 'node:http2';
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { buildAppServerEnvironment } from '../common/appServerEnvironment.js';
import { ChildProcessJsonlTransport, DEFAULT_MAX_JSONL_FRAME_BYTES } from './childProcessJsonlTransport.js';
import { WEB_APP_SERVER_PROTOCOL_VERSION, WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_DISCONNECT_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_CLOSED_EVENT } from '../common/appServerTransport.js';

interface WebAppServerOptions {
	readonly workspaceRoot: string;
	readonly profileRoot: string;
	readonly executable: string;
	readonly appServer: string;
	readonly ripgrep: string;
	readonly productServices?: string;
}

interface WebAppServerSession {
	readonly transport: ChildProcessJsonlTransport;
	readonly terminated: Promise<void>;
}

/**
 * Attaches a same-origin loopback WebSocket with one connection carrier per browser.
 */
export function attachWebAppServer(server: Server | Http2SecureServer, options: WebAppServerOptions): () => Promise<void> {
	const { workspaceRoot, profileRoot, executable, ripgrep } = options;
	const sessions = new Map<WebSocket, Promise<WebAppServerSession>>();
	const terminations = new Set<Promise<void>>();
	const sockets = new WebSocketServer({ noServer: true, maxPayload: DEFAULT_MAX_JSONL_FRAME_BYTES, perMessageDeflate: false });
	const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
		if (request.url !== '/ash/app-server') return;
		if (!isAllowedWebOrigin(request.headers.origin, request.headers.host) || !isLoopbackHostname(request.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '')) {
			socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
			return;
		}
		sockets.handleUpgrade(request, socket, head, client => sockets.emit('connection', client));
	};
	server.on('upgrade', upgrade);
	sockets.on('connection', client => {
		const onConnect = (): void => {
			void connectClient(client).catch((error) => {
				send(client, WEB_APP_SERVER_CLOSED_EVENT, { message: error instanceof Error ? error.message : 'App Server startup failed' });
				closeClient(client);
			});
		};
		const onFrame = (payload: unknown): void => {
			const pending = sessions.get(client);
			if (!pending) {
				send(client, WEB_APP_SERVER_CLOSED_EVENT, { message: "App Server bridge is not connected" });
				return;
			}
			void pending.then((session) => session.transport.send(readFrame(payload))).catch((error: unknown) => {
				send(client, WEB_APP_SERVER_CLOSED_EVENT, { message: error instanceof Error ? error.message : 'App Server bridge failed' });
				closeClient(client);
			});
		};
		client.on('message', (bytes, binary) => {
			try {
				if (binary) throw new Error('Expected a text message');
				const message = JSON.parse(bytes.toString());
				if (!message || typeof message !== 'object') throw new Error('Invalid transport message');
				switch (message.event) {
					case WEB_APP_SERVER_CONNECT_EVENT:
						if (message.payload?.protocolVersion !== WEB_APP_SERVER_PROTOCOL_VERSION) throw new Error('Unsupported transport version');
						onConnect();
						break;
					case WEB_APP_SERVER_FRAME_EVENT: onFrame(message.payload); break;
					case WEB_APP_SERVER_DISCONNECT_EVENT: closeClient(client); break;
					default: throw new Error('Unknown transport event');
				}
			} catch {
				closeClient(client);
				client.close(1008, 'Invalid transport message');
			}
		});
		client.on('close', () => closeClient(client));
		client.on('error', () => closeClient(client));
	});
	let disposal: Promise<void> | undefined;
	const dispose = (): Promise<void> => {
		if (disposal) return disposal;
		server.off('upgrade', upgrade);
		server.off('close', dispose);
		for (const client of sessions.keys()) closeClient(client);
		for (const client of sockets.clients) {
			client.terminate();
		}
		disposal = Promise.all([
			...terminations,
			new Promise<void>(resolve => sockets.close(() => resolve())),
		]).then(() => { });
		return disposal;
	};
	server.once('close', dispose);
	return dispose;

	async function connectClient(client: WebSocket): Promise<WebAppServerSession> {
		if (disposal || client.readyState !== WebSocket.OPEN) throw new Error('Browser connection is closed');
		let pending = sessions.get(client);
		if (!pending) {
			pending = createSession(client);
			sessions.set(client, pending);
			const termination = pending.then(session => session.terminated, () => { });
			terminations.add(termination);
			void termination.then(() => terminations.delete(termination));
		}
		const session = await pending;
		send(client, WEB_APP_SERVER_CONNECTED_EVENT, {
			protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION,
			workspaceId: `web-dev:${workspaceRoot}`,
			workspaceRoot,
		});
		return session;
	}

	async function createSession(client: WebSocket): Promise<WebAppServerSession> {
		if (!existsSync(executable)) {
			throw new Error(`Packaged Ash binary is missing: ${executable}`);
		}
		if (!existsSync(ripgrep)) {
			throw new Error(`Packaged ripgrep binary is missing: ${ripgrep}`);
		}
		await mkdir(profileRoot, { recursive: true });
		if (disposal || client.readyState !== WebSocket.OPEN) throw new Error('Browser connection is closed');
		const child = spawn(executable, ["connect"], {
			cwd: workspaceRoot,
			env: buildAppServerEnvironment(process.env, process.platform === 'win32' ? 'windows' : 'posix', {
				ASH_HOME: profileRoot,
				ASH_RG_PATH: ripgrep,
				ASH_WORKSPACE_ROOT: workspaceRoot,
				ASH_APP_SERVER_PATH: options.appServer,
				...(options.productServices ? { ASH_PRODUCT_SERVICES_PATH: options.productServices } : {}),
			}),
			shell: false,
			stdio: "pipe",
			windowsHide: true,
		});
		const terminated = new Promise<void>(resolve => child.once('close', () => resolve()));
		const transport = new ChildProcessJsonlTransport(child);
		const listeners = new DisposableStore();
		listeners.add(transport.onFrame(frame => send(client, WEB_APP_SERVER_FRAME_EVENT, { frame })));
		listeners.add(transport.onClose(error => {
			const diagnostics = transport.diagnostics().trim();
			const message = diagnostics ? `${error.message}: ${diagnostics}`.slice(0, 8_000) : error.message;
			send(client, WEB_APP_SERVER_CLOSED_EVENT, { message });
			sessions.delete(client);
			listeners.dispose();
			// Closing can notify observers synchronously; finish it after this notification.
			queueMicrotask(() => { void transport.close(); });
		}));
		return { transport, terminated };
	}

	function closeClient(client: WebSocket): void {
		const pending = sessions.get(client);
		if (!pending) return;
		sessions.delete(client);
		void pending.then((session) => session.transport.close(), () => { });
	}
}

export function isAllowedWebOrigin(origin: unknown, host: unknown): boolean {
	if (typeof origin !== "string" || typeof host !== "string") return false;
	let parsed;
	try {
		parsed = new URL(origin);
	} catch {
		return false;
	}
	return (
		(parsed.protocol === "http:" || parsed.protocol === "https:") &&
		parsed.host === host &&
		isLoopbackHostname(parsed.hostname) &&
		!parsed.username &&
		!parsed.password
	);
}

function isLoopbackHostname(hostname: string): boolean {
	return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function readFrame(payload: unknown): string {
	if (!payload || typeof payload !== "object" || !("frame" in payload) || typeof payload.frame !== "string") {
		throw new TypeError("Web App Server bridge frame is invalid");
	}
	return payload.frame;
}

function send(client: WebSocket, event: string, payload: unknown): void {
	try {
		const message = JSON.stringify({ event, payload });
		if (client.bufferedAmount + Buffer.byteLength(message) > DEFAULT_MAX_JSONL_FRAME_BYTES) {
			client.terminate();
			return;
		}
		if (client.readyState === WebSocket.OPEN) client.send(message);
	} catch {
		// Socket teardown owns process cleanup.
	}
}
