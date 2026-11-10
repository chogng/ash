import { randomUUID } from 'node:crypto';
import { VSBuffer, decodeBase64, encodeBase64 } from '../../../../base/common/buffer.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { Event } from '../../../../base/common/event.js';
import { isRecord } from '../../../../base/common/types.js';
import type { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ChatGPTAuthenticationError, chatGPTEntityDetailPath, chatGPTPrepareTokenHeader, isChatGPTProjectMemoryScope, readChatGPTGalleryImageUrl, type ChatGPTRequest, type ChatGPTResponse } from '../common/chatGPTTransport.js';
import type { ChatGPTRecentHistoryGate } from './chatGPTRecentHistoryGate.js';
import type { ChatGPTRequestHeaderHandler, IChatGPTVerificationRuntime } from './chatGPTVerificationRuntime.js';
import type { IChatGPTAuthentication, IChatGPTAuthorization } from './chatGPTAuthentication.js';

const readPaths = new Set(['/backend-api/models', '/backend-api/conversations', '/backend-api/pins', '/backend-api/gizmos/snorlax/sidebar']);
const createProjectPath = '/backend-api/projects';
const forkPath = '/backend-api/conversation/new_branch';
const conversationSendPaths = new Set(['/backend-api/f/conversation/prepare', '/backend-api/f/conversation', '/backend-api/f/conversation/resume']);
const writePaths = new Set([...conversationSendPaths, '/backend-api/stop_conversation', '/backend-api/files', '/backend-api/share/v2/create', createProjectPath, forkPath, '/realtime/vp', chatGPTEntityDetailPath]);
const uploadedPath = (path: string): boolean => /^\/backend-api\/files\/[^/]+\/uploaded$/u.test(path);
const nativeHistoryPath = (path: string): boolean => /^\/backend-api\/conversations\/[A-Za-z0-9_-]{1,240}(?:\/messages)?$/u.test(path);
const conversationPath = (path: string): boolean => path !== forkPath && /^\/backend-api\/conversation\/[^/]+$/u.test(path);
const projectDetailsPath = (path: string): boolean => /^\/backend-api\/gizmos\/g-p-[A-Za-z0-9_-]{1,240}$/u.test(path);
const projectUpdatePath = (path: string): boolean => /^\/backend-api\/projects\/g-p-[A-Za-z0-9_-]{1,240}$/u.test(path);
const projectFilesPath = (path: string): boolean => /^\/backend-api\/projects\/g-p-[A-Za-z0-9_-]{1,240}\/files$/u.test(path);
const projectFilePath = (path: string): boolean => /^\/backend-api\/projects\/g-p-[A-Za-z0-9_-]{1,240}\/files\/file[-_][A-Za-z0-9_-]{1,240}$/u.test(path);
const projectFileId = (value: unknown): boolean => typeof value === 'string' && /^file[-_][A-Za-z0-9_-]{1,240}$/u.test(value);
const projectId = (value: unknown): boolean => typeof value === 'string' && /^g-p-[A-Za-z0-9_-]{1,240}$/u.test(value);
const processProjectUploadPath = '/backend-api/files/process_upload_stream';
const projectConversationsPath = (path: string): boolean => /^\/backend-api\/gizmos\/g-p-[A-Za-z0-9_-]{1,240}\/conversations$/u.test(path);
const renamePath = (path: string): boolean => /^\/backend-api\/conversation\/id\/[^/]+\/rename$/u.test(path);
const deletePath = (path: string): boolean => /^\/backend-api\/conversation\/id\/[^/]+$/u.test(path);
const filePath = (path: string): boolean => /^\/backend-api\/(?:files\/[^/]+(?:\/download)?|conversation\/[^/]+\/(?:interpreter\/download|files\/[^/]+(?:\/download)?)|estuary\/content)$/u.test(path);
const synthesisPath = '/backend-api/synthesize';
const validIdentifier = (value: unknown): boolean => typeof value === 'string' && /^[A-Za-z0-9_-]{1,240}$/u.test(value);
const proofHeaders = ['OpenAI-Sentinel-Chat-Requirements-Token', 'OpenAI-Sentinel-Proof-Token', 'OpenAI-Sentinel-Turnstile-Token', chatGPTPrepareTokenHeader];
const requestHeaders = new Set(['accept', 'content-type', 'x-conduit-token', 'x-ms-blob-type', 'chatgpt-project-id', ...proofHeaders.map(name => name.toLowerCase())]);
const credentialHeaders = new Set(['authorization', 'chatgpt-account-id', 'x-openai-fedramp']);
interface PendingRequest {
	readonly controller: AbortController;
	authorization?: IChatGPTAuthorization;
	bytesRead?: number;
	reader?: ReadableStreamDefaultReader<Uint8Array>;
	reading?: boolean;
}

export interface ChatGPTTransportOptions {
	readonly native?: boolean;
	readonly recentHistoryGate?: ChatGPTRecentHistoryGate;
	readonly authentication: IChatGPTAuthentication;
	readonly readVerificationScript: (signal: AbortSignal) => Promise<string>;
	readonly createRuntime: (prepareRequestHeaders: ChatGPTRequestHeaderHandler) => IChatGPTVerificationRuntime;
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
				if (command === 'request' && args.length === 3 && typeof args[2] === 'string' && /^[a-f0-9]{32}$/u.test(args[2])) { return await this.request(args[0], readRequest(args[1], this.options.native === true), args[2]) as T; }
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
		if (headersOnly) {
			return this.prepareVerification(context, signal, url.pathname === chatGPTEntityDetailPath);
		}
		try {
			const send = async () => {
				signal.throwIfAborted();
				const runtime = this.getRuntime(context);
				const response = await this.fetchAuthorized(runtime, url, { method: request.method, headers: request.headers, body: request.body instanceof VSBuffer ? request.body.buffer : request.body, credentials: 'include', redirect: 'error', signal }, authorization);
				if (!response.ok) {
					const isConversationSend = conversationSendPaths.has(url.pathname);
					this.logService.warn('chatgpt', 'ChatGPT rejected an HTTP request', {
						status: response.status, method: request.method,
						// Record only fixed paths and normalized response signals.
						path: readPaths.has(url.pathname) || isConversationSend ? url.pathname : undefined,
						...(isConversationSend && response.status === 403 ? {
							channel: this.options.native ? 'native' : 'web',
							cloudflareChallenge: response.headers.get('cf-mitigated') === 'challenge',
							isHtml: /^text\/html(?:;|$)/iu.test(response.headers.get('content-type') ?? ''),
						} : {}),
					});
				}
				return response;
			};
			const gate = request.method === 'GET' && url.pathname === '/backend-api/conversations' ? this.options.recentHistoryGate : undefined;
			const response = gate && authorization.cacheScope ? await gate.request(authorization.cacheScope, this.options.native === true, signal, send) : await send();
			const contentType = response.headers.get('content-type') ?? '';
			const headers = new Headers();
			const retryAfter = response.status === 429 ? response.headers.get('Retry-After') : null;
			if (retryAfter !== null) { headers.set('Retry-After', retryAfter); }
			const sdp = url.pathname === '/realtime/vp' && /^text\/plain(?:;|$)/iu.test(contentType);
			const audio = url.pathname === synthesisPath && /^audio\/(?:mpeg|mp3)(?:;|$)/iu.test(contentType);
			const uploadEvents = request.method === 'POST' && url.pathname === processProjectUploadPath && /^application\/x-ndjson(?:;|$)/iu.test(contentType);
			if (response.status !== 204 && !sdp && !audio && !uploadEvents && !/^(?:application\/(?:[\w.-]+\+)?json|text\/event-stream)(?:;|$)/iu.test(contentType)) {
				await response.body?.cancel();
				return new Response(null, { status: response.ok ? 502 : response.status, headers });
			}
			headers.set('Content-Type', contentType);
			return new Response(response.body, { status: response.status, headers });
		} catch (error) { signal.throwIfAborted(); if (error instanceof ChatGPTAuthenticationError) { throw error; } return new Response(null, { status: 502 }); }
	}

	/** Only the ChatGPT web asset origin receives login headers. Signed CDN requests carry no credentials. */
	private async fetchResource(source: string, signal: AbortSignal, context: string, authorization: IChatGPTAuthorization): Promise<Response> {
		let url = readResourceUrl(source);
		const runtime = this.getRuntime(context);
		for (let redirects = 0; redirects < 5; redirects++) {
			signal.throwIfAborted();
			const galleryImage = !!readChatGPTGalleryImageUrl(url.href);
			const response = url.origin === 'https://chatgpt.com'
				? await this.fetchAuthorized(runtime, url, { credentials: 'omit', redirect: 'manual', signal }, authorization)
				: await runtime.session.fetch(url.href, { credentials: 'omit', redirect: galleryImage ? 'error' : 'manual', signal });
			const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
			if (galleryImage && (!response.ok || !/^image\/(?:avif|gif|jpeg|png|webp)(?:;|$)/iu.test(contentType))) {
				await response.body?.cancel();
				return new Response(null, { status: response.ok ? 502 : response.status });
			}
			if ([301, 302, 303, 307, 308].includes(response.status)) {
				await response.body?.cancel();
				url = readResourceUrl(new URL(response.headers.get('location') ?? '', url).href);
				continue;
			}
			if (Number(response.headers.get('content-length')) > (galleryImage ? 16 : 64) * 1024 * 1024) { await response.body?.cancel(); throw new Error('ChatGPT resource exceeds the limit'); }
			return new Response(response.body, { status: response.status, headers: { 'Content-Type': contentType } });
		}
		throw new Error('ChatGPT resource redirected too many times');
	}

	private async prepareVerification(context: string, signal: AbortSignal, sidebar: boolean): Promise<Response> {
		// Only the proof request can be retried here. The message has not been submitted.
		for (let attempt = 1; attempt <= 2; attempt++) {
			signal.throwIfAborted();
			const runtime = this.getRuntime(context);
			const started = Date.now();
			let phase: 'script' | 'runtime' | 'headers' = 'script';
			const deadline = AbortSignal.timeout(35_000);
			const proofSignal = AbortSignal.any([signal, deadline]);
			let failedPhase: string | undefined;
			try {
				const script = await raceCancellationError(this.options.readVerificationScript(proofSignal), proofSignal);
				if (script.length > 128 * 1024) { throw new Error('ChatGPT verification script exceeds the limit'); }
				phase = 'runtime';
				const value = await raceCancellationError(runtime.prepareHeaders(script, proofSignal, sidebar), proofSignal);
				if (!isRecord(value)) { throw new Error('Invalid ChatGPT verification headers'); }
				const stage = value.failedPhase;
				if (stage === 'discovery' || stage === 'import' || stage === 'requirements' || stage === 'headers') {
					failedPhase = stage;
					throw new Error('ChatGPT verification did not complete');
				}
				phase = 'headers';
				const headers: Record<string, string> = {};
				for (const name of proofHeaders) {
					const token = value[name];
					if (token === undefined) { continue; }
					if (typeof token !== 'string' || !token || token.length > 65536 || /[\r\n\0]/u.test(token)) { throw new Error('Invalid ChatGPT verification header'); }
					headers[name] = token;
				}
				if (!headers[sidebar ? chatGPTPrepareTokenHeader : proofHeaders[0]]) { throw new Error('ChatGPT verification headers are unavailable'); }
				if (attempt > 1) {
					this.logService.info('chatgpt', 'ChatGPT send verification recovered', { attempt, durationMs: Date.now() - started, requests: runtime.verificationRequests });
				}
				return Response.json(headers);
			} catch {
				signal.throwIfAborted();
				const timedOut = deadline.aborted;
				this.logService.warn('chatgpt', 'ChatGPT send verification did not complete', {
					attempt, phase: failedPhase ?? (phase === 'runtime' ? runtime.verificationPhase ?? phase : phase),
					timedOut, durationMs: Date.now() - started, requests: runtime.verificationRequests,
				});
				if (this.runtime === runtime) { runtime.dispose(); this.runtime = undefined; }
				if (!timedOut) break;
			}
		}
		return new Response(null, { status: 428 });
	}

	private async fetchAuthorized(runtime: IChatGPTVerificationRuntime, url: URL, init: RequestInit, authorization: IChatGPTAuthorization): Promise<Response> {
		const send = (credentials: Headers): Promise<Response> => {
			const headers = new Headers(init.headers);
			for (const [name, value] of credentials) { headers.set(name, value); }
			if (init.method === 'GET' && (conversationPath(url.pathname) || nativeHistoryPath(url.pathname))) {
				// ChatGPT drops rich reply markup from history for the Electron UA.
				headers.set('User-Agent', runtime.session.getUserAgent().replace(/ Electron\/[^\s]+/gu, ''));
			}
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
		if (this.runtime && (this.runtime.isDisposed || this.runtimeContext !== context)) { this.runtime.dispose(); this.runtime = undefined; }
		this.runtimeContext = context;
		return this.runtime ??= this.options.createRuntime(async (url, method, incomingHeaders) => {
			// Clear stale credentials and account routing before applying the current owner's headers.
			const headers = { ...incomingHeaders };
			for (const name of Object.keys(headers)) {
				if (credentialHeaders.has(name.toLowerCase())) { delete headers[name]; }
			}
			const path = url.pathname;
			if (url.origin !== 'https://chatgpt.com' || /%(?:2f|5c|00|25)/iu.test(path)) return headers;
			const projectFileWrite = !url.search && (method === 'POST' && projectFilesPath(path) || method === 'DELETE' && projectFilePath(path));
			const projectFileDownload = method === 'GET' && isProjectFileDownloadUrl(url);
			if (!(readPaths.has(path) || writePaths.has(path) || uploadedPath(path) || conversationPath(path)
				|| this.options.native && nativeHistoryPath(path) || renamePath(path) || deletePath(path)
				|| projectDetailsPath(path) || projectConversationsPath(path) || projectUpdatePath(path)
				|| projectFileWrite || projectFileDownload
				|| filePath(path) || path.startsWith('/backend-api/sentinel/'))) return headers;
			using authorization = await this.options.authentication.authorize(randomUUID(), context, new AbortController().signal);
			for (const [name, value] of authorization.headers) { headers[name] = value; }
			return headers;
		});
	}
}

function readRequest(value: unknown, native: boolean): ChatGPTRequest {
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
	const query = url.searchParams;
	const synthesis = url.pathname === synthesisPath && query.size === 4
		&& validIdentifier(query.get('conversation_id')) && validIdentifier(query.get('message_id'))
		&& query.get('voice') === 'juniper' && query.get('format') === 'mp3';
	const before = query.get('before');
	const nativeHistory = native && nativeHistoryPath(url.pathname)
		&& query.get('num_turns') === '20' && query.get('include_has_versions') === 'true'
		&& (url.pathname.endsWith('/messages')
			? query.size === 3 && before !== null && before.length > 0 && before.length <= 2048
			: query.size === 2);
	const projectConversations = projectConversationsPath(url.pathname) && query.get('limit') === '20' && query.get('owned_only') === 'false'
		&& query.size === (query.has('cursor') ? 3 : 2) && (!query.has('cursor') || (query.get('cursor')?.length ?? 0) > 0);
	const projectDetails = projectDetailsPath(url.pathname) && (!url.search || query.size === 1 && query.get('include_file_limits') === 'true');
	const allowed = url.origin === 'https://chatgpt.com' && !/%(?:2f|5c|00|25)/iu.test(url.pathname) && (headersOnly
		? value.method === 'POST' && (url.pathname === '/backend-api/f/conversation' || url.pathname === chatGPTEntityDetailPath) && !url.search && value.body === undefined
		: value.method === 'GET'
			? readPaths.has(url.pathname) || conversationPath(url.pathname) || nativeHistory || projectConversations || projectDetails || synthesis
			: !url.search && (value.method === 'POST'
				? writePaths.has(url.pathname) || uploadedPath(url.pathname) || renamePath(url.pathname) || projectFilesPath(url.pathname) || url.pathname === processProjectUploadPath
				: value.method === 'PATCH' ? conversationPath(url.pathname) || projectUpdatePath(url.pathname)
					: value.method === 'DELETE' && (deletePath(url.pathname) || projectDetailsPath(url.pathname) || projectFilePath(url.pathname))));
	if (!allowed || (value.method === 'GET' && value.body !== undefined)) { throw new TypeError('Invalid ChatGPT endpoint'); }
	if (value.method === 'DELETE' && value.body !== undefined) { throw new TypeError('Invalid ChatGPT deletion'); }
	validateProjectFileRequest(url.pathname, value.method, new Headers(value.headers as Record<string, string>), value.body);
	if (!headersOnly && url.pathname === chatGPTEntityDetailPath) {
		const headers = new Headers(value.headers as Record<string, string>);
		if (!headers.get(chatGPTPrepareTokenHeader) || headers.get('content-type') !== 'application/json' || headers.get('accept') !== 'text/event-stream') {
			throw new TypeError('Invalid ChatGPT entity detail headers');
		}
		validateEntityDetailRequest(value.body);
	}
	if (value.method === 'POST' && url.pathname === createProjectPath) {
		let body: unknown;
		try { body = typeof value.body === 'string' ? JSON.parse(value.body) : undefined; }
		catch { throw new TypeError('Invalid ChatGPT project creation'); }
		if (!isRecord(body) || Object.keys(body).length !== (body.memory_scope === undefined ? 4 : 5)
			|| typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200
			|| typeof body.instructions !== 'string' || body.instructions.length > 20000
			|| (body.memory_scope !== undefined && !isChatGPTProjectMemoryScope(body.memory_scope))
			|| body.emoji !== null || body.theme !== null) {
			throw new TypeError('Invalid ChatGPT project creation');
		}
	}
	if (value.method === 'PATCH' && projectUpdatePath(url.pathname)) {
		let body: unknown;
		try { body = typeof value.body === 'string' ? JSON.parse(value.body) : undefined; }
		catch { throw new TypeError('Invalid ChatGPT project update'); }
		if (!isRecord(body) || Object.keys(body).length !== (body.memory_scope === undefined ? 4 : 5)
			|| typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200
			|| typeof body.instructions !== 'string' || body.instructions.length > 20000
			|| (body.memory_scope !== undefined && !isChatGPTProjectMemoryScope(body.memory_scope))
			|| !(body.emoji === null || typeof body.emoji === 'string' && body.emoji.length <= 256)
			|| !(body.theme === null || typeof body.theme === 'string' && body.theme.length <= 256)) {
			throw new TypeError('Invalid ChatGPT project update');
		}
		return value as unknown as ChatGPTRequest;
	}
	if (value.method === 'PATCH' || renamePath(url.pathname) || url.pathname === '/backend-api/share/v2/create' || url.pathname === forkPath) {
		let body: unknown;
		try { body = typeof value.body === 'string' ? JSON.parse(value.body) : undefined; }
		catch { throw new TypeError('Invalid ChatGPT conversation update'); }
		if (!isRecord(body)) { throw new TypeError('Invalid ChatGPT conversation update'); }
		const valid = value.method === 'PATCH'
			? Object.keys(body).length === 1 && (typeof body.is_starred === 'boolean' || body.is_archived === true
				|| validIdentifier(body.current_node_id)
				|| body.gizmo_id === null || (typeof body.gizmo_id === 'string' && /^g-p-[A-Za-z0-9_-]{1,240}$/u.test(body.gizmo_id)))
			: renamePath(url.pathname)
				? Object.keys(body).length === 1 && typeof body.title === 'string' && !!body.title.trim() && body.title.length <= 256
				: url.pathname === forkPath
					? value.method === 'POST' && Object.keys(body).length === 2 && validIdentifier(body.conversation_id) && validIdentifier(body.message_id)
					: Object.keys(body).length === 3 && body.is_anonymous === true && validIdentifier(body.conversation_id) && validIdentifier(body.current_node_id);
		if (!valid) { throw new TypeError('Invalid ChatGPT conversation update'); }
	}
	return value as unknown as ChatGPTRequest;
}

function validateEntityDetailRequest(source: unknown): void {
	let body: unknown;
	try { body = typeof source === 'string' ? JSON.parse(source) : undefined; }
	catch { throw new TypeError('Invalid ChatGPT entity detail request'); }
	if (!isRecord(body) || Object.keys(body).length !== 5 || body.category !== 'generic_entity'
		|| !validIdentifier(body.conversation_id) || !validIdentifier(body.message_id)
		|| typeof body.locale !== 'string' || !/^[A-Za-z0-9-]{1,35}$/u.test(body.locale)) {
		throw new TypeError('Invalid ChatGPT entity detail request');
	}
	const entity = body.generic_entity_params;
	if (!isRecord(entity) || Object.keys(entity).length !== 4 || entity.multi_message_mode !== true
		|| typeof entity.category !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(entity.category)
		|| typeof entity.name !== 'string' || !entity.name.trim() || entity.name.length > 256
		|| !isRecord(entity.extra_params) || Object.keys(entity.extra_params).length !== 1
		|| typeof entity.extra_params.disambiguation !== 'string' || entity.extra_params.disambiguation.length > 1024) {
		throw new TypeError('Invalid ChatGPT entity detail request');
	}
}

function validateProjectFileRequest(path: string, method: unknown, headers: Headers, body: unknown): void {
	const scope = headers.get('chatgpt-project-id');
	const processing = path === processProjectUploadPath;
	const creating = path === '/backend-api/files' && scope !== null;
	const adding = method === 'POST' && projectFilesPath(path);
	if (!processing && !creating && !adding && scope === null) return;
	const invalid = () => new TypeError('Invalid ChatGPT project file request');
	if (method !== 'POST' || !(processing || creating || adding) || adding && scope !== null) throw invalid();
	let payload: unknown;
	try { payload = typeof body === 'string' ? JSON.parse(body) : undefined; }
	catch { throw invalid(); }
	const name = (value: unknown) => typeof value === 'string' && !!value.trim() && value.length <= 1024 && !/[\r\n\0]/u.test(value);
	const size = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 20 * 1024 * 1024;
	const mime = (value: unknown) => typeof value === 'string' && /^[\w.+-]+\/[\w.+-]+$/u.test(value) && value.length <= 256;
	if (!isRecord(payload)) throw invalid();
	if (adding) {
		if (Object.keys(payload).length !== 1 || !Array.isArray(payload.files) || payload.files.length !== 1) throw invalid();
		const file: unknown = payload.files[0];
		if (!isRecord(file) || Object.keys(file).some(key => !['file_id', 'last_modified', 'library_file_id', 'location', 'name', 'size', 'type'].includes(key))
			|| !projectFileId(file.file_id) || !name(file.name) || !size(file.size) || !mime(file.type) || file.location !== 'fs'
			|| typeof file.last_modified !== 'number' || !Number.isSafeInteger(file.last_modified)
			|| file.library_file_id !== undefined && !validIdentifier(file.library_file_id)) throw invalid();
		return;
	}
	if (!projectId(scope) || payload.gizmo_id !== scope || payload.use_case !== 'gizmo' || !name(payload.file_name) || !mime(payload.mime_type)) throw invalid();
	if (creating && (Object.keys(payload).length !== 8 || !size(payload.file_size) || payload.reset_rate_limits !== false
		|| payload.supports_direct_azure_multipart !== false || typeof payload.timezone_offset_min !== 'number'
		|| !Number.isInteger(payload.timezone_offset_min) || Math.abs(payload.timezone_offset_min) > 24 * 60)) throw invalid();
	if (processing && (Object.keys(payload).length !== 7 || !projectFileId(payload.file_id)
		|| payload.entry_surface !== 'project_sources' || typeof payload.index_for_retrieval !== 'boolean')) throw invalid();
}

function readUploadUrl(value: string): URL {
	const url = readResourceUrl(value);
	if (url.origin === 'https://chatgpt.com' || readChatGPTGalleryImageUrl(url.href) || !url.search) { throw new TypeError('Invalid ChatGPT upload origin'); }
	return url;
}

function isProjectFileDownloadUrl(url: URL): boolean {
	return /^\/backend-api\/files\/download\/file[-_][A-Za-z0-9_-]{1,240}$/u.test(url.pathname)
		&& url.searchParams.size === 2 && projectId(url.searchParams.get('gizmo_id')) && url.searchParams.get('inline') === 'false';
}

function readResourceUrl(value: string): URL {
	const url = new URL(value, 'https://chatgpt.com');
	if (value.length > 8192 || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || /[\r\n\0\\]|%(?:2f|5c|00|25)/iu.test(url.pathname)) { throw new TypeError('Invalid ChatGPT resource URL'); }
	const webAsset = url.origin === 'https://chatgpt.com' && (filePath(url.pathname) || isProjectFileDownloadUrl(url));
	const signedAsset = ['oaiusercontent.com', 'blob.core.windows.net'].some(domain => url.hostname.endsWith('.' + domain));
	if (!webAsset && !signedAsset && !readChatGPTGalleryImageUrl(url.href)) { throw new TypeError('Invalid ChatGPT resource origin'); }
	return url;
}
