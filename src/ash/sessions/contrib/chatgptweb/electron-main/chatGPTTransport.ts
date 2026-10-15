import { open } from 'node:fs/promises';
import { createHmac, randomBytes } from 'node:crypto';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isRecord } from '../../../../base/common/types.js';
import type { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { chatGPTAccountHeader, chatGPTAccountScopeHeader, type ChatGPTRequest, type ChatGPTResponse, type IChatGPTTransport } from '../common/chatGPTTransport.js';
import type { IChatGPTVerificationRuntime } from './chatGPTVerificationRuntime.js';

const readPaths = new Set(['/backend-api/me', '/backend-api/models', '/backend-api/conversations']);
const writePaths = new Set(['/backend-api/f/conversation/prepare', '/backend-api/f/conversation', '/backend-api/stop_conversation']);
const conversationPath = (path: string): boolean => /^\/backend-api\/conversation\/[^/]+$/u.test(path);
const proofHeaders = ['OpenAI-Sentinel-Chat-Requirements-Token', 'OpenAI-Sentinel-Proof-Token', 'OpenAI-Sentinel-Turnstile-Token'];
const requestHeaders = new Set(['accept', 'content-type', chatGPTAccountHeader.toLowerCase(), 'x-conduit-token', ...proofHeaders.map(name => name.toLowerCase())]);
interface PendingRequest {
	readonly controller: AbortController;
	reader?: ReadableStreamDefaultReader<Uint8Array>;
	reading?: boolean;
}
interface Account { readonly headers: Headers; readonly binding: string; readonly scope: string; }

export interface ChatGPTTransportOptions {
	readonly credentialFile: string;
	readonly readVerificationScript: (signal: AbortSignal) => Promise<string>;
	readonly createRuntime: (authorize: (url: URL) => Promise<Headers>) => IChatGPTVerificationRuntime;
}

/** A window-owned HTTP/credential adapter. It has no conversation model, drafts or UI messages. */
export class ChatGPTTransport extends Disposable implements IChatGPTTransport {
	private readonly requests = new Map<string, PendingRequest>();
	private readonly bindingKey = randomBytes(32);
	private runtime: { readonly binding: string; readonly value: IChatGPTVerificationRuntime; } | undefined;

	constructor(private readonly options: ChatGPTTransportOptions) {
		super();
		this._register(toDisposable(() => {
			for (const id of this.requests.keys()) { void this.cancel(id); }
			this.runtime?.value.dispose();
			this.runtime = undefined;
		}));
	}

	getChannel(): IServerChannel<string> {
		return {
			call: async <T>(_context: string, command: string, args: unknown): Promise<T> => {
				if (!Array.isArray(args) || typeof args[0] !== 'string' || !/^[a-f0-9-]{36}$/u.test(args[0])) { throw new TypeError('Invalid ChatGPT request ID'); }
				if (command === 'request' && args.length === 2) { return await this.request(args[0], readRequest(args[1])) as T; }
				if (command === 'read' && args.length === 1) { return await this.read(args[0]) as T; }
				if (command === 'cancel' && args.length === 1) { return await this.cancel(args[0]) as T; }
				throw new TypeError('Invalid ChatGPT transport operation');
			},
			listen: () => { throw new Error('ChatGPT transport has no events'); },
		};
	}

	async request(id: string, request: ChatGPTRequest): Promise<ChatGPTResponse> {
		if (this.isDisposed || this.requests.has(id) || this.requests.size >= 16) { throw new Error('ChatGPT transport is unavailable'); }
		const pending: PendingRequest = { controller: new AbortController() };
		this.requests.set(id, pending);
		try {
			const response = await this.fetch(request, pending.controller.signal);
			pending.controller.signal.throwIfAborted();
			pending.reader = response.body?.getReader();
			return { status: response.status, headers: Object.fromEntries(response.headers) };
		} catch (error) { await this.cancel(id); throw error; }
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
			if (chunk.done) { this.requests.delete(id); pending.reader.releaseLock(); return null; }
			if (chunk.value.byteLength > 1024 * 1024) { throw new Error('ChatGPT response chunk exceeds the limit'); }
			return VSBuffer.wrap(new Uint8Array(chunk.value));
		} catch (error) { await this.cancel(id); throw error; }
		finally { pending.reading = false; }
	}

	async cancel(id: string): Promise<void> {
		const pending = this.requests.get(id);
		if (!pending) { return; }
		this.requests.delete(id);
		pending.controller.abort();
		await pending.reader?.cancel().catch(() => { });
	}

	private async fetch(request: ChatGPTRequest, signal: AbortSignal): Promise<Response> {
		let account: Account;
		try { account = await this.readAccount(); }
		catch { return new Response(null, { status: 401 }); }
		signal.throwIfAborted();
		const headersOnly = request.path.startsWith('/service/.headers/');
		const url = new URL(request.path.replace(headersOnly ? '/service/.headers' : '/service', ''), 'https://chatgpt.com');
		if (!(request.method === 'GET' && url.pathname === '/backend-api/me' && !url.search)
			&& new Headers(request.headers).get(chatGPTAccountHeader) !== account.binding) { return new Response(null, { status: 409 }); }
		const runtime = this.getRuntime(account);
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
				if (this.runtime?.value === runtime) { runtime.dispose(); this.runtime = undefined; }
				return new Response(null, { status: 428 });
			}
		}
		const headers = new Headers(request.headers);
		headers.delete(chatGPTAccountHeader);
		for (const [name, value] of account.headers) { headers.set(name, value); }
		// Verification and other file/network awaits must not let an old draft borrow a new login.
		try { if ((await this.readAccount()).binding !== account.binding) { return new Response(null, { status: 409 }); } }
		catch { return new Response(null, { status: 401 }); }
		signal.throwIfAborted();
		try {
			const response = await runtime.session.fetch(url.href, { method: request.method, headers, body: request.body, credentials: 'include', redirect: 'error', signal });
			const contentType = response.headers.get('content-type') ?? '';
			if (response.status !== 204 && !/^(?:application\/(?:[\w.-]+\+)?json|text\/event-stream)(?:;|$)/iu.test(contentType)) {
				await response.body?.cancel();
				return new Response(null, { status: response.ok ? 502 : response.status });
			}
			return new Response(response.body, {
				status: response.status, headers: {
					'Content-Type': contentType, ...(response.ok ? { [chatGPTAccountHeader]: account.binding, [chatGPTAccountScopeHeader]: account.scope } : {}),
				}
			});
		} catch { signal.throwIfAborted(); return new Response(null, { status: 502 }); }
	}

	private getRuntime(account: Account): IChatGPTVerificationRuntime {
		if (this.runtime?.binding === account.binding) { return this.runtime.value; }
		this.runtime?.value.dispose();
		const value = this.options.createRuntime(async url => {
			const headers = new Headers({ Authorization: '', 'ChatGPT-Account-Id': '' });
			if (url.origin !== 'https://chatgpt.com' || /%(?:2f|5c|00|25)/iu.test(url.pathname) || !(readPaths.has(url.pathname) || writePaths.has(url.pathname) || conversationPath(url.pathname) || url.pathname.startsWith('/backend-api/sentinel/'))) { return headers; }
			const current = await this.readAccount();
			if (current.binding !== account.binding) { throw new Error('ChatGPT account changed'); }
			return current.headers;
		});
		this.runtime = { binding: account.binding, value };
		return value;
	}

	private async readAccount(): Promise<Account> {
		const file = await open(this.options.credentialFile, 'r');
		const bytes = Buffer.alloc(1024 * 1024 + 1);
		try {
			let length = 0;
			while (length < bytes.length) {
				const next = await file.read(bytes, length, bytes.length - length, null);
				if (!next.bytesRead) { break; }
				length += next.bytesRead;
			}
			if (length === bytes.length) { throw new Error('ChatGPT credential document exceeds the limit'); }
			const value: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'));
			if (!isRecord(value) || (value.auth_mode !== undefined && value.auth_mode !== 'chatgpt') || !isRecord(value.tokens)) { throw new Error('ChatGPT login is unavailable'); }
			const token = value.tokens.access_token;
			const accountId = value.tokens.account_id;
			if (typeof token !== 'string' || !token.trim() || token.length > 16384 || /[\r\n\0]/u.test(token)
				|| (accountId != null && (typeof accountId !== 'string' || !accountId.trim() || accountId.length > 16384 || /[\r\n\0]/u.test(accountId)))) { throw new Error('ChatGPT credential field is unavailable'); }
			const headers = new Headers({ Authorization: `Bearer ${token}` });
			if (typeof accountId === 'string') { headers.set('ChatGPT-Account-Id', accountId); }
			const sign = (text: string) => createHmac('sha256', this.bindingKey).update(text).digest('hex');
			const binding = sign(JSON.stringify([token, accountId]));
			return { headers, binding, scope: typeof accountId === 'string' ? sign(accountId) : binding };
		} finally { bytes.fill(0); await file.close(); }
	}
}

function readRequest(value: unknown): ChatGPTRequest {
	if (!isRecord(value) || Object.keys(value).some(key => !['path', 'method', 'headers', 'body'].includes(key))
		|| typeof value.path !== 'string' || value.path.length > 8192 || !value.path.startsWith('/service/') || /[\r\n\0\\#]/u.test(value.path)
		|| !['GET', 'POST'].includes(value.method as string) || !isRecord(value.headers)
		|| Object.entries(value.headers).some(([name, header]) => !requestHeaders.has(name.toLowerCase()) || typeof header !== 'string' || header.length > 65536 || /[\r\n\0]/u.test(header))
		|| (value.body !== undefined && (typeof value.body !== 'string' || Buffer.byteLength(value.body) > 2 * 1024 * 1024))) { throw new TypeError('Invalid ChatGPT request'); }
	const headersOnly = value.path.startsWith('/service/.headers/');
	const url = new URL(value.path.replace(headersOnly ? '/service/.headers' : '/service', ''), 'https://chatgpt.com');
	const allowed = url.origin === 'https://chatgpt.com' && !/%(?:2f|5c|00|25)/iu.test(url.pathname) && (headersOnly
		? value.method === 'POST' && url.pathname === '/backend-api/f/conversation' && !url.search && value.body === undefined
		: value.method === 'GET'
			? readPaths.has(url.pathname) || conversationPath(url.pathname)
			: !url.search && writePaths.has(url.pathname));
	if (!allowed || (value.method === 'GET' && value.body !== undefined)) { throw new TypeError('Invalid ChatGPT endpoint'); }
	return value as unknown as ChatGPTRequest;
}
