import { open } from 'node:fs/promises';
import { VSBuffer, decodeBase64, encodeBase64 } from '../../../../base/common/buffer.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isRecord } from '../../../../base/common/types.js';
import type { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import type { ChatGPTRequest, ChatGPTResponse, IChatGPTTransport } from '../common/chatGPTTransport.js';
import type { IChatGPTVerificationRuntime } from './chatGPTVerificationRuntime.js';

const readPaths = new Set([
	'/backend-api/models',
	'/backend-api/conversations',
	'/backend-api/pins',
	'/backend-api/gizmos/snorlax/sidebar',
]);
const writePaths = new Set([
	'/backend-api/f/conversation/prepare',
	'/backend-api/f/conversation',
	'/backend-api/f/conversation/resume',
	'/backend-api/stop_conversation',
	'/backend-api/files',
	'/backend-api/share/v2/create',
	'/realtime/vp',
]);
const uploadedPath = (path: string): boolean => /^\/backend-api\/files\/[^/]+\/uploaded$/u.test(path);
const conversationPath = (path: string): boolean => /^\/backend-api\/conversation\/[^/]+$/u.test(path);
const renamePath = (path: string): boolean => /^\/backend-api\/conversation\/id\/[^/]+\/rename$/u.test(path);
const deletePath = (path: string): boolean => /^\/backend-api\/conversation\/id\/[^/]+$/u.test(path);
const filePath = (path: string): boolean =>
	/^\/backend-api\/(?:files\/[^/]+(?:\/download)?|conversation\/[^/]+\/(?:interpreter\/download|files\/[^/]+(?:\/download)?)|estuary\/content)$/u.test(
		path,
	);
const proofHeaders = [
	'OpenAI-Sentinel-Chat-Requirements-Token',
	'OpenAI-Sentinel-Proof-Token',
	'OpenAI-Sentinel-Turnstile-Token',
];
const requestHeaders = new Set([
	'accept',
	'content-type',
	'x-conduit-token',
	'x-ms-blob-type',
	...proofHeaders.map(name => name.toLowerCase()),
]);
interface PendingRequest {
	readonly controller: AbortController;
	bytesRead?: number;
	reader?: ReadableStreamDefaultReader<Uint8Array>;
	reading?: boolean;
}

export interface ChatGPTTransportOptions {
	readonly credentialFile: string;
	readonly readVerificationScript: (signal: AbortSignal) => Promise<string>;
	readonly createRuntime: (authorize: (url: URL) => Promise<Headers>) => IChatGPTVerificationRuntime;
}

/** A window-owned HTTP/credential adapter. It has no conversation model, drafts or UI messages. */
export class ChatGPTTransport extends Disposable implements IChatGPTTransport {
	private readonly requests = new Map<string, PendingRequest>();
	private runtime: IChatGPTVerificationRuntime | undefined;

	constructor(private readonly options: ChatGPTTransportOptions) {
		super();
		this._register(
			toDisposable(() => {
				for (const id of this.requests.keys()) {
					void this.cancel(id);
				}
				this.runtime?.dispose();
				this.runtime = undefined;
			}),
		);
	}

	getChannel(): IServerChannel<string> {
		return {
			call: async <T>(_context: string, command: string, args: unknown): Promise<T> => {
				if (!Array.isArray(args) || typeof args[0] !== 'string' || !/^[a-f0-9-]{36}$/u.test(args[0])) {
					throw new TypeError('Invalid ChatGPT request ID');
				}
				if (command === 'request' && args.length === 2) {
					return (await this.request(args[0], readRequest(args[1]))) as T;
				}
				if (command === 'read' && args.length === 1) {
					return (await this.read(args[0])) as T;
				}
				if (command === 'cancel' && args.length === 1) {
					return (await this.cancel(args[0])) as T;
				}
				throw new TypeError('Invalid ChatGPT transport operation');
			},
			listen: () => {
				throw new Error('ChatGPT transport has no events');
			},
		};
	}

	async request(id: string, request: ChatGPTRequest): Promise<ChatGPTResponse> {
		if (this.isDisposed || this.requests.has(id) || this.requests.size >= 16) {
			throw new Error('ChatGPT transport is unavailable');
		}
		const pending: PendingRequest = { controller: new AbortController() };
		this.requests.set(id, pending);
		try {
			const response = await this.fetch(request, pending.controller.signal);
			pending.controller.signal.throwIfAborted();
			pending.reader = response.body?.getReader();
			return { status: response.status, headers: Object.fromEntries(response.headers) };
		} catch (error) {
			await this.cancel(id);
			throw error;
		}
	}

	async read(id: string): Promise<VSBuffer | null> {
		const pending = this.requests.get(id);
		if (!pending) {
			return null;
		}
		if (pending.reading) {
			throw new Error('ChatGPT response is already being read');
		}
		if (!pending.reader) {
			await this.cancel(id);
			return null;
		}
		pending.reading = true;
		try {
			const chunk = await pending.reader.read();
			pending.controller.signal.throwIfAborted();
			if (chunk.done) {
				this.requests.delete(id);
				pending.reader.releaseLock();
				return null;
			}
			if (chunk.value.byteLength > 1024 * 1024) {
				throw new Error('ChatGPT response chunk exceeds the limit');
			}
			pending.bytesRead = (pending.bytesRead ?? 0) + chunk.value.byteLength;
			if (pending.bytesRead > 64 * 1024 * 1024) {
				throw new Error('ChatGPT response exceeds the limit');
			}
			return VSBuffer.wrap(new Uint8Array(chunk.value));
		} catch (error) {
			await this.cancel(id);
			throw error;
		} finally {
			pending.reading = false;
		}
	}

	async cancel(id: string): Promise<void> {
		const pending = this.requests.get(id);
		if (!pending) {
			return;
		}
		this.requests.delete(id);
		pending.controller.abort();
		await pending.reader?.cancel().catch(() => {});
	}

	private async fetch(request: ChatGPTRequest, signal: AbortSignal): Promise<Response> {
		if (request.path.startsWith('/service/.upload?')) {
			const url = readUploadUrl(new URL(request.path, 'https://chatgpt.com').searchParams.get('url')!);
			// Signed storage receives only the file bytes and upload headers, never the login.
			const response = await this.getRuntime().session.fetch(url.href, {
				method: 'PUT',
				headers: request.headers,
				body: (request.body as VSBuffer).buffer,
				credentials: 'omit',
				redirect: 'error',
				signal,
			});
			await response.body?.cancel();
			return new Response(null, { status: response.status });
		}
		if (request.path.startsWith('/service/.resource?')) {
			return this.fetchResource(new URL(request.path, 'https://chatgpt.com').searchParams.get('url')!, signal);
		}
		let authorization: Headers;
		try {
			authorization = await this.readCredentialHeaders();
		} catch {
			return new Response(null, { status: 401 });
		}
		signal.throwIfAborted();
		const headersOnly = request.path.startsWith('/service/.headers/');
		const url = new URL(
			request.path.replace(headersOnly ? '/service/.headers' : '/service', ''),
			'https://chatgpt.com',
		);
		const runtime = this.getRuntime();
		if (headersOnly) {
			try {
				const script = await this.options.readVerificationScript(signal);
				if (script.length > 128 * 1024) {
					throw new Error('ChatGPT verification script exceeds the limit');
				}
				const proofSignal = AbortSignal.any([signal, AbortSignal.timeout(35_000)]);
				const value = await raceCancellationError(runtime.prepareHeaders(script, proofSignal), proofSignal);
				if (!isRecord(value)) {
					throw new Error('Invalid ChatGPT verification headers');
				}
				const headers: Record<string, string> = {};
				for (const name of proofHeaders) {
					const token = value[name];
					if (token === undefined) {
						continue;
					}
					if (typeof token !== 'string' || !token || token.length > 65536 || /[\r\n\0]/u.test(token)) {
						throw new Error('Invalid ChatGPT verification header');
					}
					headers[name] = token;
				}
				if (!headers[proofHeaders[0]]) {
					throw new Error('ChatGPT verification headers are unavailable');
				}
				return Response.json(headers);
			} catch {
				signal.throwIfAborted();
				if (this.runtime === runtime) {
					runtime.dispose();
					this.runtime = undefined;
				}
				return new Response(null, { status: 428 });
			}
		}
		const headers = new Headers(request.headers);
		for (const [name, value] of authorization) {
			headers.set(name, value);
		}
		signal.throwIfAborted();
		try {
			const response = await runtime.session.fetch(url.href, {
				method: request.method,
				headers,
				body: request.body instanceof VSBuffer ? request.body.buffer : request.body,
				credentials: 'include',
				redirect: 'error',
				signal,
			});
			const contentType = response.headers.get('content-type') ?? '';
			const sdp = url.pathname === '/realtime/vp' && /^text\/plain(?:;|$)/iu.test(contentType);
			if (
				response.status !== 204 &&
				!sdp &&
				!/^(?:application\/(?:[\w.-]+\+)?json|text\/event-stream)(?:;|$)/iu.test(contentType)
			) {
				await response.body?.cancel();
				return new Response(null, { status: response.ok ? 502 : response.status });
			}
			return new Response(response.body, { status: response.status, headers: { 'Content-Type': contentType } });
		} catch {
			signal.throwIfAborted();
			return new Response(null, { status: 502 });
		}
	}

	/** Only the ChatGPT web asset origin receives login headers. Signed CDN requests carry no credentials. */
	private async fetchResource(source: string, signal: AbortSignal): Promise<Response> {
		let url = readResourceUrl(source);
		const runtime = this.getRuntime();
		for (let redirects = 0; redirects < 5; redirects++) {
			const headers = url.origin === 'https://chatgpt.com' ? await this.readCredentialHeaders() : new Headers();
			signal.throwIfAborted();
			const response = await runtime.session.fetch(url.href, {
				headers,
				credentials: 'omit',
				redirect: 'manual',
				signal,
			});
			if ([301, 302, 303, 307, 308].includes(response.status)) {
				await response.body?.cancel();
				url = readResourceUrl(new URL(response.headers.get('location') ?? '', url).href);
				continue;
			}
			if (Number(response.headers.get('content-length')) > 64 * 1024 * 1024) {
				await response.body?.cancel();
				throw new Error('ChatGPT resource exceeds the limit');
			}
			return new Response(response.body, {
				status: response.status,
				headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream' },
			});
		}
		throw new Error('ChatGPT resource redirected too many times');
	}

	private getRuntime(): IChatGPTVerificationRuntime {
		// Reuse the web verification session; the login owner supplies credentials for
		// each request. No account identity or credential-change state is retained here.
		return (this.runtime ??= this.options.createRuntime(async url => {
			const headers = new Headers({ Authorization: '', 'ChatGPT-Account-Id': '' });
			if (
				url.origin !== 'https://chatgpt.com' ||
				/%(?:2f|5c|00|25)/iu.test(url.pathname) ||
				!(
					readPaths.has(url.pathname) ||
					writePaths.has(url.pathname) ||
					uploadedPath(url.pathname) ||
					conversationPath(url.pathname) ||
					renamePath(url.pathname) ||
					deletePath(url.pathname) ||
					filePath(url.pathname) ||
					url.pathname.startsWith('/backend-api/sentinel/')
				)
			) {
				return headers;
			}
			for (const [name, value] of await this.readCredentialHeaders()) {
				headers.set(name, value);
			}
			return headers;
		}));
	}

	private async readCredentialHeaders(): Promise<Headers> {
		const file = await open(this.options.credentialFile, 'r');
		const bytes = Buffer.alloc(1024 * 1024 + 1);
		try {
			let length = 0;
			while (length < bytes.length) {
				const next = await file.read(bytes, length, bytes.length - length, null);
				if (!next.bytesRead) {
					break;
				}
				length += next.bytesRead;
			}
			if (length === bytes.length) {
				throw new Error('ChatGPT credential document exceeds the limit');
			}
			const value: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'));
			if (
				!isRecord(value) ||
				(value.auth_mode !== undefined && value.auth_mode !== 'chatgpt') ||
				!isRecord(value.tokens)
			) {
				throw new Error('ChatGPT login is unavailable');
			}
			const token = value.tokens.access_token;
			const accountId = value.tokens.account_id;
			if (
				typeof token !== 'string' ||
				!token.trim() ||
				token.length > 16384 ||
				/[\r\n\0]/u.test(token) ||
				(accountId != null &&
					(typeof accountId !== 'string' ||
						!accountId.trim() ||
						accountId.length > 16384 ||
						/[\r\n\0]/u.test(accountId)))
			) {
				throw new Error('ChatGPT credential field is unavailable');
			}
			const headers = new Headers({ Authorization: `Bearer ${token}` });
			if (typeof accountId === 'string') {
				headers.set('ChatGPT-Account-Id', accountId);
			}
			return headers;
		} finally {
			bytes.fill(0);
			await file.close();
		}
	}
}

function readRequest(value: unknown): ChatGPTRequest {
	if (isRecord(value) && isRecord(value.body) && !(value.body instanceof VSBuffer)) {
		const encoded = value.body.base64;
		if (
			Object.keys(value.body).length !== 1 ||
			typeof encoded !== 'string' ||
			encoded.length > Math.ceil((20 * 1024 * 1024) / 3) * 4 ||
			/[^A-Za-z0-9+/=]/u.test(encoded)
		) {
			throw new TypeError('Invalid ChatGPT upload bytes');
		}
		const bytes = decodeBase64(encoded);
		if (encodeBase64(bytes) !== encoded) {
			throw new TypeError('Invalid ChatGPT upload encoding');
		}
		value = { ...value, body: bytes };
	}
	if (
		!isRecord(value) ||
		Object.keys(value).some(key => !['path', 'method', 'headers', 'body'].includes(key)) ||
		typeof value.path !== 'string' ||
		value.path.length > 8192 ||
		!value.path.startsWith('/service/') ||
		/[\r\n\0\\#]/u.test(value.path) ||
		!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(value.method as string) ||
		!isRecord(value.headers) ||
		Object.entries(value.headers).some(
			([name, header]) =>
				!requestHeaders.has(name.toLowerCase()) ||
				typeof header !== 'string' ||
				header.length > 65536 ||
				/[\r\n\0]/u.test(header),
		) ||
		(value.body !== undefined &&
			!(typeof value.body === 'string'
				? Buffer.byteLength(value.body) <= 2 * 1024 * 1024
				: value.body instanceof VSBuffer && value.body.byteLength <= 20 * 1024 * 1024))
	) {
		throw new TypeError('Invalid ChatGPT request');
	}
	if (value.path.startsWith('/service/.upload?')) {
		const url = new URL(value.path, 'https://chatgpt.com');
		if (
			value.method !== 'PUT' ||
			!(value.body instanceof VSBuffer) ||
			url.searchParams.size !== 1 ||
			!url.searchParams.has('url') ||
			Object.keys(value.headers).some(name => !['content-type', 'x-ms-blob-type'].includes(name.toLowerCase()))
		) {
			throw new TypeError('Invalid ChatGPT upload request');
		}
		readUploadUrl(url.searchParams.get('url')!);
		return value as unknown as ChatGPTRequest;
	}
	if (
		value.path === '/service/realtime/vp?dcid=0' &&
		value.method === 'POST' &&
		value.body instanceof VSBuffer &&
		value.body.byteLength <= 128 * 1024 &&
		Object.keys(value.headers).length === 1 &&
		/^multipart\/form-data; boundary=[\w-]{1,100}$/u.test(
			new Headers(value.headers as Record<string, string>).get('Content-Type') ?? '',
		)
	) {
		return value as unknown as ChatGPTRequest;
	}
	if (value.body instanceof VSBuffer || value.method === 'PUT') {
		throw new TypeError('Invalid ChatGPT upload endpoint');
	}
	const headersOnly = value.path.startsWith('/service/.headers/');
	if (
		value.path.startsWith('/service/.resource?') &&
		value.method === 'GET' &&
		value.body === undefined &&
		Object.keys(value.headers).length === 0
	) {
		const url = new URL(value.path, 'https://chatgpt.com');
		if (url.searchParams.size !== 1 || !url.searchParams.has('url')) {
			throw new TypeError('Invalid ChatGPT resource request');
		}
		readResourceUrl(url.searchParams.get('url')!);
		return value as unknown as ChatGPTRequest;
	}
	const url = new URL(value.path.replace(headersOnly ? '/service/.headers' : '/service', ''), 'https://chatgpt.com');
	const allowed =
		url.origin === 'https://chatgpt.com' &&
		!/%(?:2f|5c|00|25)/iu.test(url.pathname) &&
		(headersOnly
			? value.method === 'POST' &&
				url.pathname === '/backend-api/f/conversation' &&
				!url.search &&
				value.body === undefined
			: value.method === 'GET'
				? readPaths.has(url.pathname) || conversationPath(url.pathname)
				: !url.search &&
					(value.method === 'POST'
						? writePaths.has(url.pathname) || uploadedPath(url.pathname) || renamePath(url.pathname)
						: value.method === 'PATCH'
							? conversationPath(url.pathname)
							: value.method === 'DELETE' && deletePath(url.pathname)));
	if (!allowed || (value.method === 'GET' && value.body !== undefined)) {
		throw new TypeError('Invalid ChatGPT endpoint');
	}
	if (value.method === 'DELETE' && value.body !== undefined) {
		throw new TypeError('Invalid ChatGPT deletion');
	}
	if (value.method === 'PATCH' || renamePath(url.pathname) || url.pathname === '/backend-api/share/v2/create') {
		let body: unknown;
		try {
			body = typeof value.body === 'string' ? JSON.parse(value.body) : undefined;
		} catch {
			throw new TypeError('Invalid ChatGPT conversation update');
		}
		if (!isRecord(body)) {
			throw new TypeError('Invalid ChatGPT conversation update');
		}
		const valid =
			value.method === 'PATCH'
				? Object.keys(body).length === 1 &&
					(typeof body.is_starred === 'boolean' ||
						body.is_archived === true ||
						(typeof body.gizmo_id === 'string' && /^g-p-[A-Za-z0-9_-]{1,240}$/u.test(body.gizmo_id)))
				: renamePath(url.pathname)
					? Object.keys(body).length === 1 &&
						typeof body.title === 'string' &&
						!!body.title.trim() &&
						body.title.length <= 256
					: Object.keys(body).length === 3 &&
						body.is_anonymous === true &&
						typeof body.conversation_id === 'string' &&
						/^[A-Za-z0-9_-]{1,240}$/u.test(body.conversation_id) &&
						typeof body.current_node_id === 'string' &&
						/^[A-Za-z0-9_-]{1,240}$/u.test(body.current_node_id);
		if (!valid) {
			throw new TypeError('Invalid ChatGPT conversation update');
		}
	}
	return value as unknown as ChatGPTRequest;
}

function readUploadUrl(value: string): URL {
	const url = readResourceUrl(value);
	if (url.origin === 'https://chatgpt.com' || !url.search) {
		throw new TypeError('Invalid ChatGPT upload origin');
	}
	return url;
}

function readResourceUrl(value: string): URL {
	const url = new URL(value, 'https://chatgpt.com');
	if (
		value.length > 8192 ||
		url.protocol !== 'https:' ||
		url.port ||
		url.username ||
		url.password ||
		url.hash ||
		/[\r\n\0\\]|%(?:2f|5c|00|25)/iu.test(url.pathname)
	) {
		throw new TypeError('Invalid ChatGPT resource URL');
	}
	const webAsset = url.origin === 'https://chatgpt.com' && filePath(url.pathname);
	const signedAsset = ['oaiusercontent.com', 'blob.core.windows.net'].some(domain =>
		url.hostname.endsWith('.' + domain),
	);
	if (!webAsset && !signedAsset) {
		throw new TypeError('Invalid ChatGPT resource origin');
	}
	return url;
}
