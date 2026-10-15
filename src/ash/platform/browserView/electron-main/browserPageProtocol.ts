import type { Session } from 'electron/main';
import { open, readFile } from 'node:fs/promises';
import { createHmac, randomBytes } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { raceCancellationError } from '../../../base/common/async.js';
import { browserPageScheme, browserPageRequestHeader, browserPageAccountHeader, browserPageAccountScopeHeader, type IBrowserPageDescriptor } from '../common/browserPage.js';
import type { IBrowserPageRemoteRuntime } from './browserPageRemoteRuntime.js';

/** Trusted host configuration; file paths and credential values are never exposed to the page. */
interface BrowserPageRegistration extends IBrowserPageDescriptor {
	readonly remoteHeaders?: {
		readonly url: string;
		readonly script: string;
		readonly paths: readonly string[];
		readonly credentialPaths: readonly string[];
		readonly headers: readonly string[];
	};
	readonly credentials?: {
		readonly file: string;
		readonly identityRequest: string;
		readonly requirements?: readonly { readonly path: readonly string[]; readonly value: string; readonly allowMissing?: boolean; }[];
		readonly fields: readonly { readonly path: readonly string[]; readonly header: string; readonly prefix?: string; readonly optional?: boolean; readonly identity?: boolean; }[];
	};
}

/** Static assets, a credential-bound HTTP relay, and isolated request-header provider lifetimes. */
export class BrowserPageProtocol extends Disposable {
	private readonly sessions = new Set<Session>();
	private readonly bindingKey = randomBytes(32);
	private readonly remoteRuntimes = new Map<Session, Map<string, { binding: string | undefined; runtime: IBrowserPageRemoteRuntime; }>>();

	constructor(
		private readonly rendererRoot: string,
		private readonly developmentUrl: string | undefined,
		private readonly pages: readonly BrowserPageRegistration[],
		private readonly createRemoteRuntime?: (url: string, authorize: (url: URL) => Promise<Headers | undefined>) => IBrowserPageRemoteRuntime,
	) {
		super();
		this._register(toDisposable(() => {
			for (const runtimes of this.remoteRuntimes.values()) { for (const entry of runtimes.values()) { entry.runtime.dispose(); } }
			this.remoteRuntimes.clear();
		}));
	}

	attach(session: Session): void {
		if (this.sessions.has(session)) { return; }
		this.sessions.add(session);
		session.protocol.handle(browserPageScheme, request => this.respond(session, request));
		this._register(toDisposable(() => session.protocol.unhandle(browserPageScheme)));
	}

	private async respond(session: Session, request: Request): Promise<Response> {
		const url = new URL(request.url);
		const page = this.pages.find(page => page.host === url.hostname);
		const origin = `${browserPageScheme}://${url.hostname}`;
		const initiator = request.headers.get('origin');
		if (!page || url.port || url.username || url.password || (initiator && initiator !== origin)) {
			return new Response(null, { status: 403 });
		}
		if (url.pathname.startsWith('/service/')) { return this.relay(session, request, page, url); }
		if (request.method !== 'GET') { return new Response(null, { status: 405 }); }
		try {
			if (this.developmentUrl) {
				const developmentAsset = new URL(url.pathname + url.search, this.developmentUrl);
				if (developmentAsset.origin !== new URL(this.developmentUrl).origin) { return new Response(null, { status: 403 }); }
				const response = await session.fetch(developmentAsset.href, { redirect: 'error', signal: request.signal });
				return new Response(response.body, { status: response.status, headers: this.assetHeaders(response.headers.get('content-type') ?? '') });
			}
			const path = url.pathname.slice(1);
			if (path !== page.entry && !/^assets\/(?:[\w.~+-]+\/)*[\w.~+-]+\.(?:js|css|woff2?|ttf|svg|png)$/u.test(path)) { return new Response(null, { status: 404 }); }
			const file = resolve(this.rendererRoot, path);
			if (!file.startsWith(resolve(this.rendererRoot) + sep)) { return new Response(null, { status: 403 }); }
			if (path !== page.entry && !file.startsWith(resolve(this.rendererRoot, 'assets') + sep)) { return new Response(null, { status: 403 }); }
			const contentTypes: Record<string, string> = { html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf' };
			return new Response(await readFile(file), { headers: this.assetHeaders(contentTypes[path.split('.').at(-1)!] ?? 'application/octet-stream') });
		} catch { return new Response(null, { status: 404 }); }
	}

	private assetHeaders(contentType: string): HeadersInit {
		return {
			'Content-Type': contentType,
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
			'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'${this.developmentUrl ? ' ws://127.0.0.1:*' : ''}; img-src https: data: blob:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
		};
	}

	private async relay(session: Session, request: Request, page: BrowserPageRegistration, url: URL): Promise<Response> {
		// Custom-protocol requests can omit Origin. A non-safelisted header requires a CORS
		// preflight from other origins, and this protocol never grants those preflights.
		if (request.headers.get(browserPageRequestHeader) !== page.host) {
			return new Response(null, { status: 403 });
		}
		const headersOnly = url.pathname.startsWith('/service/.headers/');
		const path = url.pathname.slice(headersOnly ? '/service/.headers'.length : '/service'.length);
		const upstream = new URL(path + url.search, page.upstream);
		if (upstream.origin !== page.upstream || /%(?:2f|5c|00|25)/iu.test(upstream.pathname) || !page.upstreamPaths.some(prefix => upstream.pathname === prefix || (prefix.endsWith('/') && upstream.pathname.startsWith(prefix)))
			|| !['GET', 'POST', 'PATCH'].includes(request.method)) { return new Response(null, { status: 403 }); }
		if (headersOnly && (request.method !== 'POST' || upstream.search || !page.remoteHeaders?.paths.includes(upstream.pathname))) { return new Response(null, { status: 403 }); }
		if (headersOnly && request.body) {
			const reader = request.body.getReader();
			try { if (!(await reader.read()).done) { await reader.cancel(); return new Response(null, { status: 403 }); } }
			finally { reader.releaseLock(); }
		}
		const headers = new Headers();
		for (const name of ['accept', 'content-type', ...(page.credentials ? [] : ['authorization']), ...page.requestHeaders ?? []]) {
			const value = request.headers.get(name);
			if (value) { headers.set(name, value); }
		}
		let accountBinding: string | undefined;
		let accountScope: string | undefined;
		if (page.credentials) {
			try {
				await this.readCredentialHeaders(page.credentials, headers);
				// A process-local, opaque binding fences a page to the exact credentials it connected
				// with. Re-read on every request: an external account change must never send its draft.
				accountBinding = this.credentialBinding(page, headers);
				const identity = page.credentials.fields.filter(field => field.identity).map(field => headers.get(field.header));
				accountScope = identity.length && identity.every(value => value) ? createHmac('sha256', this.bindingKey).update(page.host).update(JSON.stringify(identity)).digest('hex') : accountBinding;
			} catch { return new Response(null, { status: 401 }); }
			if (!(request.method === 'GET' && upstream.pathname === page.credentials.identityRequest && !upstream.search)
				&& request.headers.get(browserPageAccountHeader) !== accountBinding) {
				return new Response(null, { status: 409 });
			}
		}
		let network = session;
		if (page.remoteHeaders) {
			let phase = 'runtime';
			try {
				const runtime = this.remoteRuntime(session, page, accountBinding);
				network = runtime.session;
				if (headersOnly) {
					phase = 'script';
					const scriptPath = resolve(this.rendererRoot, page.remoteHeaders.script);
					if (!scriptPath.startsWith(resolve(this.rendererRoot) + sep)) { throw new Error('Invalid request-header script'); }
					const script = this.developmentUrl
						? await (await session.fetch(new URL(page.remoteHeaders.script, this.developmentUrl).href, { signal: request.signal, redirect: 'error' })).text()
						: await readFile(scriptPath, 'utf8');
					if (script.length > 128 * 1024) { throw new Error('Request-header script exceeds the limit'); }
					let timer: ReturnType<typeof setTimeout> | undefined;
					let value: unknown;
					try {
						phase = 'prepare';
						value = await raceCancellationError(Promise.race([runtime.prepareHeaders(script, request.signal), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Request-header provider timed out')), 35_000); })]), request.signal);
					} finally { if (timer !== undefined) { clearTimeout(timer); } }
					request.signal.throwIfAborted();
					phase = 'validate';
					if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('Invalid request headers'); }
					const result: Record<string, string> = {};
					for (const name of page.remoteHeaders.headers) {
						const token: unknown = Object.hasOwn(value, name) ? Reflect.get(value, name) : undefined;
						if (token === undefined) { continue; }
						if (typeof token !== 'string' || !token || token.length > 65536 || /[\r\n\0]/u.test(token)) { throw new Error('Invalid request header'); }
						result[name] = token;
					}
					if (!Object.keys(result).length) { throw new Error('Request headers were not prepared'); }
					return Response.json(result, { headers: { 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
				}
			} catch (error) {
				console.warn('[BrowserPage] Request-header provider failed', phase, error instanceof Error ? error.name : 'unknown');
				this.remoteRuntimes.get(session)?.get(page.host)?.runtime.dispose();
				this.remoteRuntimes.get(session)?.delete(page.host);
				return new Response(null, { status: 428 });
			}
		}
		let body: ArrayBuffer | undefined;
		if (request.method !== 'GET') {
			const chunks: Uint8Array[] = [];
			let length = 0;
			const reader = request.body?.getReader();
			try {
				while (reader) {
					const next = await reader.read();
					if (next.done) { break; }
					length += next.value.byteLength;
					if (length > 2 * 1024 * 1024) { await reader.cancel(); return new Response(null, { status: 413 }); }
					chunks.push(next.value);
				}
			} finally { reader?.releaseLock(); }
			const bytes = new Uint8Array(length);
			let offset = 0;
			for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
			body = bytes.buffer;
		}
		try {
			const response = await network.fetch(upstream.href, { method: request.method, headers, body, credentials: page.credentials && !page.remoteHeaders ? 'omit' : 'include', redirect: 'error', signal: request.signal });
			const contentType = response.headers.get('content-type') ?? '';
			const responseHeaders = {
				'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
				'Content-Security-Policy': "default-src 'none'; sandbox",
				...(accountBinding && accountScope && response.ok ? { [browserPageAccountHeader]: accountBinding, [browserPageAccountScopeHeader]: accountScope } : {}),
			};
			// Upstream HTML must never execute with the bundled page's origin or access its session.
			if (response.status !== 204 && !/^(?:application\/(?:[\w.-]+\+)?json|text\/event-stream)(?:;|$)/iu.test(contentType)) {
				await response.body?.cancel();
				return new Response(null, { status: response.ok ? 502 : response.status, headers: responseHeaders });
			}
			// Preserve streaming and failures. Never retry a message whose outcome is unknown.
			return new Response(response.body, { status: response.status, headers: responseHeaders });
		} catch { return new Response(null, { status: 502 }); }
	}

	private credentialBinding(page: BrowserPageRegistration, headers: Headers): string {
		return createHmac('sha256', this.bindingKey).update(page.host).update(JSON.stringify(page.credentials!.fields.map(field => headers.get(field.header)))).digest('hex');
	}

	private remoteRuntime(session: Session, page: BrowserPageRegistration, binding: string | undefined): IBrowserPageRemoteRuntime {
		let runtimes = this.remoteRuntimes.get(session);
		if (!runtimes) { runtimes = new Map(); this.remoteRuntimes.set(session, runtimes); }
		const previous = runtimes.get(page.host);
		if (previous && previous.binding === binding) { return previous.runtime; }
		previous?.runtime.dispose();
		runtimes.delete(page.host);
		if (!page.remoteHeaders || !this.createRemoteRuntime) { throw new Error('Browser request-header provider is unavailable'); }
		const source = page.remoteHeaders;
		if (new URL(source.url).origin !== page.upstream) { throw new Error('Invalid request-header provider origin'); }
		const runtime = this.createRemoteRuntime(source.url, async url => {
			if (!page.credentials) { return undefined; }
			// Empty values remove host-owned credential headers from unrelated requests and redirects.
			const headers = new Headers(page.credentials.fields.map(field => [field.header, '']));
			if (url.origin !== page.upstream || /%(?:2f|5c|00|25)/iu.test(url.pathname) || ![...page.upstreamPaths, ...source.credentialPaths].some(prefix => url.pathname === prefix || prefix.endsWith('/') && url.pathname.startsWith(prefix))) { return headers; }
			await this.readCredentialHeaders(page.credentials, headers);
			if (this.credentialBinding(page, headers) !== binding) { throw new Error('Account changed'); }
			return headers;
		});
		runtimes.set(page.host, { binding, runtime });
		return runtime;
	}

	private async readCredentialHeaders(source: NonNullable<BrowserPageRegistration['credentials']>, headers: Headers): Promise<void> {
		// This is a read-only file/header adapter, not a login manager. The existing owner
		// remains responsible for storage format, refresh and logout. Never cache the document.
		const file = await open(source.file, 'r');
		const bytes = Buffer.alloc(1024 * 1024 + 1);
		try {
			let length = 0;
			while (length < bytes.length) {
				const next = await file.read(bytes, length, bytes.length - length, null);
				if (!next.bytesRead) { break; }
				length += next.bytesRead;
			}
			if (length === bytes.length) { throw new Error('Credential document exceeds the limit'); }
			const document: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'));
			const read = (path: readonly string[]): unknown => {
				let value: unknown = document;
				for (const key of path) {
					value = value !== null && typeof value === 'object' && Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined;
				}
				return value;
			};
			for (const condition of source.requirements ?? []) {
				const value = read(condition.path);
				if (value !== condition.value && !(condition.allowMissing && value === undefined)) { throw new Error('Credential document does not match'); }
			}
			for (const field of source.fields) {
				const value = read(field.path);
				if (field.optional && (value === undefined || value === null)) { headers.delete(field.header); continue; }
				if (typeof value !== 'string' || !value.trim() || value.length > 16384 || /[\r\n\0]/u.test(value)) { throw new Error('Credential field is unavailable'); }
				headers.set(field.header, (field.prefix ?? '') + value);
			}
		} finally { bytes.fill(0); await file.close(); }
	}
}
