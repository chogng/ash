import { randomUUID } from 'node:crypto';
import { VSBuffer, decodeBase64, encodeBase64 } from '../../../../base/common/buffer.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { Event } from '../../../../base/common/event.js';
import { isRecord } from '../../../../base/common/types.js';
import type { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ChatGPTAuthenticationError, type ChatGPTRequest, type ChatGPTResponse } from '../common/chatGPTTransport.js';
import type { IChatGPTVerificationRuntime } from './chatGPTVerificationRuntime.js';
import type { IChatGPTAuthentication, IChatGPTAuthorization } from './chatGPTAuthentication.js';

const readPaths = new Set(['/backend-api/models', '/backend-api/conversations', '/backend-api/pins', '/backend-api/gizmos/snorlax/sidebar']);
const writePaths = new Set(['/backend-api/f/conversation/prepare', '/backend-api/f/conversation', '/backend-api/f/conversation/resume', '/backend-api/stop_conversation', '/backend-api/files', '/backend-api/share/v2/create', '/realtime/vp']);
const uploadedPath = (path: string): boolean => /^\/backend-api\/files\/[^/]+\/uploaded$/u.test(path);
const conversationPath = (path: string): boolean => /^\/backend-api\/conversation\/[^/]+$/u.test(path);
const renamePath = (path: string): boolean => /^\/backend-api\/conversation\/id\/[^/]+\/rename$/u.test(path);
const deletePath = (path: string): boolean => /^\/backend-api\/conversation\/id\/[^/]+$/u.test(path);
const filePath = (path: string): boolean => /^\/backend-api\/(?:files\/[^/]+(?:\/download)?|conversation\/[^/]+\/(?:interpreter\/download|files\/[^/]+(?:\/download)?)|estuary\/content)$/u.test(path);
const proofHeaders = ['OpenAI-Sentinel-Chat-Requirements-Token', 'OpenAI-Sentinel-Proof-Token', 'OpenAI-Sentinel-Turnstile-Token'];
const requestHeaders = new Set(['accept', 'content-type', 'x-conduit-token', 'x-ms-blob-type', ...proofHeaders.map(name => name.toLowerCase())]);
interface PendingRequest {
	readonly controller: AbortController;
	authorization?: IChatGPTAuthorization;
	bytesRead?: number;
	reader?: ReadableStreamDefaultReader<Uint8Array>;
	reading?: boolean;
}

export interface ChatGPTTransportOptions {
	readonly authentication: IChatGPTAuthentication;
	readonly readVerificationScript: (signal: AbortSignal) => Promise<string>;
	readonly createRuntime: (authorize: (url: URL) => Promise<Headers>) => IChatGPTVerificationRuntime;
}

/** A window-owned HTTP/credential adapter. It has no conversation model, drafts or UI messages. */
export class ChatGPTTransport extends Disposable {
	private readonly requests = new Map<string, PendingRequest>();
	private runtime: IChatGPTVerificationRuntime | undefined;
	private runtimeContext: string | undefined;

	constructor(private readonly options: ChatGPTTransportOptions, @ILogService private readonly logService: ILogService) {
		super();
		this._register(toDisposable(() => {
			for (const id of this.requests.keys()) { void this.cancel(id); }
			this.runtime?.dispose();
			this.runtime = undefined;
		}));
		this._register(options.authentication.onDidChangeContext(() => {
			for (const id of this.requests.keys()) { void this.cancel(id); }
			this.runtime?.dispose(); this.runtime = undefined; this.runtimeContext = undefined;
		}));
	}

	getChannel(): IServerChannel<string> {
		return {
			call: async <T>(_context: string, command: string, args: unknown): Promise<T> => {
				if (command === 'authenticationContext' && args === undefined) { return await this.options.authentication.getContext() as T; }
				if (!Array.isArray(args) || typeof args[0] !== 'string' || !/^[a-f0-9-]{36}$/u.test(args[0])) { throw new TypeError('Invalid ChatGPT request ID'); }
				if (command === 'request' && args.length === 3 && typeof args[2] === 'string' && /^[a-f0-9]{32}$/u.test(args[2])) { return await this.request(args[0], readRequest(args[1]), args[2]) as T; }
				if (command === 'read' && args.length === 1) { return await this.read(args[0]) as T; }
				if (command === 'cancel' && args.length === 1) { return await this.cancel(args[0]) as T; }
				throw new TypeError('Invalid ChatGPT transport operation');
			},
			listen: <T>(_context: string, event: string): Event<T> => {
				if (event !== 'authenticationChanged') { throw new Error('Invalid ChatGPT transport event'); }
				return this.options.authentication.onDidChangeContext as Event<T>;
			},
		};
	}

	async request(id: string, request: ChatGPTRequest, context: string): Promise<ChatGPTResponse> {
		if (this.isDisposed || this.requests.has(id) || this.requests.size >= 16) { throw new Error('ChatGPT transport is unavailable'); }
		const pending: PendingRequest = { controller: new AbortController() };
		this.requests.set(id, pending);
		try {
			const authorization = pending.authorization = await this.options.authentication.authorize(id, context, pending.controller.signal);
			const response = await this.fetch(request, authorization.signal, context, authorization);
			pending.controller.signal.throwIfAborted();
			authorization.signal.throwIfAborted();
			pending.reader = response.body?.getReader();
			return { status: response.status, headers: Object.fromEntries(response.headers) };
		} catch (error) {
			await this.cancel(id);
			if (error instanceof ChatGPTAuthenticationError) { this.logService.warn('chatgpt', 'Authentication owner could not authorize a request'); }
			throw error;
		}
	}

	async read(id: string): Promise<VSBuffer | null> {
		const pending = this.requests.get(id);
		if (!pending) { return null; }
		if (pending.reading) { throw new Error('ChatGPT response is already being read'); }
		if (!pending.reader) { await this.cancel(id); return null; }
		pending.reading = true;
		try {
			const chunk = await pending.reader.read();
			pending.controller.signal.throwIfAborted();
			if (chunk.done) { this.requests.delete(id); pending.reader.releaseLock(); pending.authorization?.dispose(); return null; }
			if (chunk.value.byteLength > 1024 * 1024) { throw new Error('ChatGPT response chunk exceeds the limit'); }
			pending.bytesRead = (pending.bytesRead ?? 0) + chunk.value.byteLength;
			if (pending.bytesRead > 64 * 1024 * 1024) { throw new Error('ChatGPT response exceeds the limit'); }
			return VSBuffer.wrap(new Uint8Array(chunk.value));
		} catch (error) { await this.cancel(id); throw error; }
		finally { pending.reading = false; }
	}

	async cancel(id: string): Promise<void> {
		const pending = this.requests.get(id);
		if (!pending) { return; }
		this.requests.delete(id);
		pending.controller.abort();
		pending.authorization?.dispose();
		await pending.reader?.cancel().catch(() => { });
	}

	private async fetch(request: ChatGPTRequest, signal: AbortSignal, context: string, authorization: IChatGPTAuthorization): Promise<Response> {
		if (request.path.startsWith('/service/.upload?')) {
			const url = readUploadUrl(new URL(request.path, 'https://chatgpt.com').searchParams.get('url')!);
			// Signed storage receives only the file bytes and upload headers, never the login.
			const response = await this.getRuntime(context).session.fetch(url.href, {
				method: 'PUT', headers: request.headers, body: (request.body as VSBuffer).buffer,
				credentials: 'omit', redirect: 'error', signal,
			});
			await response.body?.cancel();
			return new Response(null, { status: response.status });
		}
		if (request.path.startsWith('/service/.resource?')) {
			return this.fetchResource(new URL(request.path, 'https://chatgpt.com').searchParams.get('url')!, signal, context, authorization);
		}
		signal.throwIfAborted();
		const headersOnly = request.path.startsWith('/service/.headers/');
		const url = new URL(request.path.replace(headersOnly ? '/service/.headers' : '/service', ''), 'https://chatgpt.com');
		const runtime = this.getRuntime(context);
		if (headersOnly) {
			try {
				const script = await this.options.readVerificationScript(signal);
				if (script.length > 128 * 1024) { throw new Error('ChatGPT verification script exceeds the limit'); }
				const proofSignal = AbortSignal.any([signal, AbortSignal.timeout(35_000)]);
				const value = await raceCancellationError(runtime.prepareHeaders(script, proofSignal), proofSignal);
				if (!isRecord(value)) { throw new Error('Invalid ChatGPT verification headers'); }
				const headers: Record<string, string> = {};
				for (const name of proofHeaders) {
					const token = value[name];
					if (token === undefined) { continue; }
					if (typeof token !== 'string' || !token || token.length > 65536 || /[\r\n\0]/u.test(token)) { throw new Error('Invalid ChatGPT verification header'); }
					headers[name] = token;
				}
				if (!headers[proofHeaders[0]]) { throw new Error('ChatGPT verification headers are unavailable'); }
				return Response.json(headers);
			} catch {
				signal.throwIfAborted();
				if (this.runtime === runtime) { runtime.dispose(); this.runtime = undefined; }
				return new Response(null, { status: 428 });
			}
		}
		signal.throwIfAborted();
		try {
			const response = await this.fetchAuthorized(runtime, url, { method: request.method, headers: request.headers, body: request.body instanceof VSBuffer ? request.body.buffer : request.body, credentials: 'include', redirect: 'error', signal }, authorization);
			if (!response.ok) {
				this.logService.warn('chatgpt', 'ChatGPT rejected an HTTP request', {
					status: response.status, method: request.method,
					// Keep conversation and file identifiers out of diagnostic logs.
					path: readPaths.has(url.pathname) ? url.pathname : undefined,
				});
			}
			const contentType = response.headers.get('content-type') ?? '';
			const sdp = url.pathname === '/realtime/vp' && /^text\/plain(?:;|$)/iu.test(contentType);
			if (response.status !== 204 && !sdp && !/^(?:application\/(?:[\w.-]+\+)?json|text\/event-stream)(?:;|$)/iu.test(contentType)) {
				await response.body?.cancel();
				return new Response(null, { status: response.ok ? 502 : response.status });
			}
			return new Response(response.body, {
				status: response.status, headers: {
					'Content-Type': contentType,
				}
			});
		} catch (error) { signal.throwIfAborted(); if (error instanceof ChatGPTAuthenticationError) { throw error; } return new Response(null, { status: 502 }); }
	}

	/** Only the ChatGPT web asset origin receives login headers. Signed CDN requests carry no credentials. */
	private async fetchResource(source: string, signal: AbortSignal, context: string, authorization: IChatGPTAuthorization): Promise<Response> {
		let url = readResourceUrl(source);
		const runtime = this.getRuntime(context);
		for (let redirects = 0; redirects < 5; redirects++) {
			signal.throwIfAborted();
			const response = url.origin === 'https://chatgpt.com'
				? await this.fetchAuthorized(runtime, url, { credentials: 'omit', redirect: 'manual', signal }, authorization)
				: await runtime.session.fetch(url.href, { credentials: 'omit', redirect: 'manual', signal });
			if ([301, 302, 303, 307, 308].includes(response.status)) {
				await response.body?.cancel();
				url = readResourceUrl(new URL(response.headers.get('location') ?? '', url).href);
				continue;
			}
			if (Number(response.headers.get('content-length')) > 64 * 1024 * 1024) { await response.body?.cancel(); throw new Error('ChatGPT resource exceeds the limit'); }
			return new Response(response.body, { status: response.status, headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream' } });
		}
		throw new Error('ChatGPT resource redirected too many times');
	}

	private async fetchAuthorized(runtime: IChatGPTVerificationRuntime, url: URL, init: RequestInit, authorization: IChatGPTAuthorization): Promise<Response> {
		const send = (credentials: Headers): Promise<Response> => {
			const headers = new Headers(init.headers);
			for (const [name, value] of credentials) { headers.set(name, value); }
			return runtime.session.fetch(url.href, { ...init, headers });
		};
		let response = await send(authorization.headers);
		if (response.status === 401) {
			await response.body?.cancel();
			const recovered = await raceCancellationError(authorization.recoverUnauthorized(), authorization.signal);
			authorization.signal.throwIfAborted();
			if (recovered) {
				response = await send(recovered);
			} else { return new Response(null, { status: response.status, headers: response.headers }); }
		}
		return response;
	}

	private getRuntime(context: string): IChatGPTVerificationRuntime {
		if (this.runtime && this.runtimeContext !== context) { this.runtime.dispose(); this.runtime = undefined; }
		this.runtimeContext = context;
		return this.runtime ??= this.options.createRuntime(async url => {
			// Empty values remove stale account routing and credentials from Chromium
			// subrequests before the current owner's headers are applied.
			const headers = new Headers({ Authorization: '', 'ChatGPT-Account-Id': '', 'X-OpenAI-Fedramp': '' });
			if (url.origin !== 'https://chatgpt.com' || /%(?:2f|5c|00|25)/iu.test(url.pathname) || !(readPaths.has(url.pathname) || writePaths.has(url.pathname) || uploadedPath(url.pathname) || conversationPath(url.pathname) || renamePath(url.pathname) || deletePath(url.pathname) || filePath(url.pathname) || url.pathname.startsWith('/backend-api/sentinel/'))) { return headers; }
			using authorization = await this.options.authentication.authorize(randomUUID(), context, new AbortController().signal);
			for (const [name, value] of authorization.headers) { headers.set(name, value); }
			return headers;
		});
	}
}

function readRequest(value: unknown): ChatGPTRequest {
	if (isRecord(value) && isRecord(value.body) && !(value.body instanceof VSBuffer)) {
		const encoded = value.body.base64;
		if (Object.keys(value.body).length !== 1 || typeof encoded !== 'string' || encoded.length > Math.ceil(20 * 1024 * 1024 / 3) * 4 || /[^A-Za-z0-9+/=]/u.test(encoded)) { throw new TypeError('Invalid ChatGPT upload bytes'); }
		const bytes = decodeBase64(encoded);
		if (encodeBase64(bytes) !== encoded) { throw new TypeError('Invalid ChatGPT upload encoding'); }
		value = { ...value, body: bytes };
	}
	if (!isRecord(value) || Object.keys(value).some(key => !['path', 'method', 'headers', 'body'].includes(key))
		|| typeof value.path !== 'string' || value.path.length > 8192 || !value.path.startsWith('/service/') || /[\r\n\0\\#]/u.test(value.path)
		|| !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(value.method as string) || !isRecord(value.headers)
		|| Object.entries(value.headers).some(([name, header]) => !requestHeaders.has(name.toLowerCase()) || typeof header !== 'string' || header.length > 65536 || /[\r\n\0]/u.test(header))
		|| (value.body !== undefined && !(typeof value.body === 'string' ? Buffer.byteLength(value.body) <= 2 * 1024 * 1024 : value.body instanceof VSBuffer && value.body.byteLength <= 20 * 1024 * 1024))) { throw new TypeError('Invalid ChatGPT request'); }
	if (value.path.startsWith('/service/.upload?')) {
		const url = new URL(value.path, 'https://chatgpt.com');
		if (value.method !== 'PUT' || !(value.body instanceof VSBuffer) || url.searchParams.size !== 1 || !url.searchParams.has('url')
			|| Object.keys(value.headers).some(name => !['content-type', 'x-ms-blob-type'].includes(name.toLowerCase()))) { throw new TypeError('Invalid ChatGPT upload request'); }
		readUploadUrl(url.searchParams.get('url')!);
		return value as unknown as ChatGPTRequest;
	}
	if (value.path === '/service/realtime/vp?dcid=0' && value.method === 'POST' && value.body instanceof VSBuffer && value.body.byteLength <= 128 * 1024
		&& Object.keys(value.headers).length === 1 && /^multipart\/form-data; boundary=[\w-]{1,100}$/u.test(new Headers(value.headers as Record<string, string>).get('Content-Type') ?? '')) {
		return value as unknown as ChatGPTRequest;
	}
	if (value.body instanceof VSBuffer || value.method === 'PUT') { throw new TypeError('Invalid ChatGPT upload endpoint'); }
	const headersOnly = value.path.startsWith('/service/.headers/');
	if (value.path.startsWith('/service/.resource?') && value.method === 'GET' && value.body === undefined && Object.keys(value.headers).length === 0) {
		const url = new URL(value.path, 'https://chatgpt.com');
		if (url.searchParams.size !== 1 || !url.searchParams.has('url')) { throw new TypeError('Invalid ChatGPT resource request'); }
		readResourceUrl(url.searchParams.get('url')!);
		return value as unknown as ChatGPTRequest;
	}
	const url = new URL(value.path.replace(headersOnly ? '/service/.headers' : '/service', ''), 'https://chatgpt.com');
	const allowed = url.origin === 'https://chatgpt.com' && !/%(?:2f|5c|00|25)/iu.test(url.pathname) && (headersOnly
		? value.method === 'POST' && url.pathname === '/backend-api/f/conversation' && !url.search && value.body === undefined
		: value.method === 'GET'
			? readPaths.has(url.pathname) || conversationPath(url.pathname)
			: !url.search && (value.method === 'POST'
				? writePaths.has(url.pathname) || uploadedPath(url.pathname) || renamePath(url.pathname)
				: value.method === 'PATCH' ? conversationPath(url.pathname)
					: value.method === 'DELETE' && deletePath(url.pathname)));
	if (!allowed || (value.method === 'GET' && value.body !== undefined)) { throw new TypeError('Invalid ChatGPT endpoint'); }
	if (value.method === 'DELETE' && value.body !== undefined) { throw new TypeError('Invalid ChatGPT deletion'); }
	if (value.method === 'PATCH' || renamePath(url.pathname) || url.pathname === '/backend-api/share/v2/create') {
		let body: unknown;
		try { body = typeof value.body === 'string' ? JSON.parse(value.body) : undefined; }
		catch { throw new TypeError('Invalid ChatGPT conversation update'); }
		if (!isRecord(body)) { throw new TypeError('Invalid ChatGPT conversation update'); }
		const valid = value.method === 'PATCH'
			? Object.keys(body).length === 1 && (typeof body.is_starred === 'boolean' || body.is_archived === true
				|| (typeof body.gizmo_id === 'string' && /^g-p-[A-Za-z0-9_-]{1,240}$/u.test(body.gizmo_id)))
			: renamePath(url.pathname)
				? Object.keys(body).length === 1 && typeof body.title === 'string' && !!body.title.trim() && body.title.length <= 256
				: Object.keys(body).length === 3 && body.is_anonymous === true && typeof body.conversation_id === 'string' && /^[A-Za-z0-9_-]{1,240}$/u.test(body.conversation_id)
				&& typeof body.current_node_id === 'string' && /^[A-Za-z0-9_-]{1,240}$/u.test(body.current_node_id);
		if (!valid) { throw new TypeError('Invalid ChatGPT conversation update'); }
	}
	return value as unknown as ChatGPTRequest;
}

function readUploadUrl(value: string): URL {
	const url = readResourceUrl(value);
	if (url.origin === 'https://chatgpt.com' || !url.search) { throw new TypeError('Invalid ChatGPT upload origin'); }
	return url;
}

function readResourceUrl(value: string): URL {
	const url = new URL(value, 'https://chatgpt.com');
	if (value.length > 8192 || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || /[\r\n\0\\]|%(?:2f|5c|00|25)/iu.test(url.pathname)) { throw new TypeError('Invalid ChatGPT resource URL'); }
	const webAsset = url.origin === 'https://chatgpt.com' && filePath(url.pathname);
	const signedAsset = ['oaiusercontent.com', 'blob.core.windows.net'].some(domain => url.hostname.endsWith('.' + domain));
	if (!webAsset && !signedAsset) { throw new TypeError('Invalid ChatGPT resource origin'); }
	return url;
}
