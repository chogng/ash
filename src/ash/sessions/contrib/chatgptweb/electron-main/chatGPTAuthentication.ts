import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { HostCredentialRequest, HostCredentialResponse } from '../../../../../../.build/protocol/typescript/HostCredentials.js';
import { decodeHostCredentialResponse } from '../../../../../../.build/protocol/typescript/AppServerProtocolDecoder.js';
import { DeferredPromise, raceCancellationError, TaskQueue } from '../../../../base/common/async.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { IAppServerProcessLauncher } from '../../../../platform/agentHost/electron-main/appServerProcessLauncher.js';
import type { AppServerConnectionState } from '../../../../platform/agentHost/common/appServerApi.js';
import { ChatGPTAuthenticationError } from '../common/chatGPTTransport.js';

export interface IChatGPTAuthorization extends IDisposable {
	readonly headers: Headers;
	readonly signal: AbortSignal;
	recoverUnauthorized(): Promise<Headers | undefined>;
}

/** Private host capability. Header values never enter the renderer transport. */
export interface IChatGPTAuthentication extends IDisposable {
	readonly onDidChangeContext: Event<string | undefined>;
	getContext(): Promise<string>;
	authorize(id: string, context: string, signal: AbortSignal): Promise<IChatGPTAuthorization>;
}

/** A native-only carrier to the existing Rust authentication owner, without JSON-RPC. */
export class ChatGPTAuthentication extends Disposable implements IChatGPTAuthentication {
	private readonly carrier = this._register(new MutableDisposable<DisposableStore>());
	private readonly changes = this._register(new Emitter<string | undefined>());
	public readonly onDidChangeContext = this.changes.event;
	private readonly states = this._register(new Emitter<AppServerConnectionState>());
	public readonly onStateChange = this.states.event;
	public state: AppServerConnectionState = 'stopped';
	private readonly operations = new TaskQueue();
	private readonly leases = new Map<string, AbortController>();
	private process: ChildProcessWithoutNullStreams | undefined;
	private starting: Promise<void> | undefined;
	private pending: DeferredPromise<HostCredentialResponse> | undefined;
	private ready: DeferredPromise<void> | undefined;
	private context: string | undefined;
	private generation = 0;
	private queued = 0;

	constructor(private readonly options: { readonly enabled: false; } | { readonly enabled: true; readonly launcher: IAppServerProcessLauncher; }) {
		super();
		this._register(toDisposable(() => { void this.stop(); }));
	}

	public async getContext(): Promise<string> {
		await this.start();
		if (!this.context) { throw unavailable(); }
		return this.context;
	}

	public start(): Promise<void> {
		this.assertNotDisposed();
		if (this.state === 'ready') { return Promise.resolve(); }
		if (this.starting) { return this.starting; }
		const generation = ++this.generation;
		this.setState('starting');
		const starting = this.connect(generation).catch(() => {
			if (generation === this.generation) { this.disconnect('crashed'); }
			throw unavailable();
		});
		this.starting = starting;
		void starting.then(() => { if (this.starting === starting) { this.starting = undefined; } }, () => { if (this.starting === starting) { this.starting = undefined; } });
		return starting;
	}

	private async connect(generation: number): Promise<void> {
		if (!this.options.enabled) { throw unavailable(); }
		const launcher = this.options.launcher;
		await launcher.validate();
		this.assertNotDisposed();
		if (generation !== this.generation) { throw unavailable(); }
		const ready = this.ready = new DeferredPromise<void>();
		const resources = new DisposableStore();
		const process = this.process = launcher.launch();
		this.carrier.value = resources;
		let text = '';
		const decoder = new StringDecoder('utf8');
		const fail = (): void => {
			if (generation !== this.generation) { return; }
			if (!ready.isSettled) { void ready.error(unavailable()); }
			this.disconnect('crashed');
		};
		const data = (bytes: Buffer): void => {
			if (generation !== this.generation) { return; }
			text += decoder.write(bytes);
			if (text.length > 128 * 1024) { fail(); return; }
			try {
				for (let end = text.indexOf('\n'); end >= 0; end = text.indexOf('\n')) {
					const frame = decodeHostCredentialResponse(JSON.parse(text.slice(0, end)));
					text = text.slice(end + 1);
					if (frame.kind === 'ready') {
						if (ready.isSettled || !validContext(frame.context)) { throw unavailable(); }
						this.context = frame.context;
						this.setState('ready');
						void ready.complete();
					} else if (frame.kind === 'changed') {
						if (!ready.isSettled || !validContext(frame.context)) { throw unavailable(); }
						this.context = frame.context;
						this.revoke();
						this.changes.fire(frame.context);
					} else {
						const pending = this.pending;
						if (!pending) { throw unavailable(); }
						this.pending = undefined;
						void pending.complete(frame);
					}
				}
			} catch { fail(); }
		};
		process.stdout.on('data', data);
		process.on('error', fail);
		process.on('exit', fail);
		process.stdout.on('end', fail);
		process.stdin.on('error', () => { });
		// Private stdout contains credentials. Neither stream is a diagnostic source.
		process.stderr.resume();
		resources.add(toDisposable(() => {
			process.stdout.off('data', data);
			process.off('error', fail); process.off('exit', fail); process.stdout.off('end', fail);
			process.stdin.end();
			if (process.exitCode === null) { process.kill(); }
			text = '';
		}));
		const timeout = setTimeout(fail, launcher.initializeTimeoutMs ?? 30_000);
		try { await ready.p; }
		finally { clearTimeout(timeout); if (this.ready === ready) { this.ready = undefined; } }
	}

	public authorize(id: string, context: string, signal: AbortSignal): Promise<IChatGPTAuthorization> {
		const authorize = async (): Promise<IChatGPTAuthorization> => {
			await this.start();
			signal.throwIfAborted();
			if (context !== this.context || this.leases.has(id)) { throw unavailable(); }
			const controller = new AbortController();
			this.leases.set(id, controller);
			const combined = AbortSignal.any([signal, controller.signal]);
			const release = toDisposable(() => {
				if (this.leases.get(id) !== controller) { return; }
				this.leases.delete(id);
				controller.abort();
				void this.call({ kind: 'release', requestId: id }).catch(() => { });
			});
			try {
				const response = await this.call({ kind: 'authorize', requestId: id, context });
				combined.throwIfAborted();
				if (response.kind !== 'authorized' || context !== this.context) { throw unavailable(); }
				return {
					headers: readHeaders(response.headers), signal: combined,
					recoverUnauthorized: async () => {
						combined.throwIfAborted();
						const recovered = await this.call({ kind: 'recover', requestId: id });
						combined.throwIfAborted();
						if (recovered.kind !== 'recovered' || context !== this.context) { throw unavailable(); }
						return recovered.headers === null ? undefined : readHeaders(recovered.headers);
					},
					dispose: () => release.dispose(), [Symbol.dispose]: () => release.dispose(),
				};
			} catch (error) { release.dispose(); throw error; }
		};
		// An owner refresh already exchanging a single-use token must finish its
		// commit. Cancellation stops the consumer immediately and releases its late grant.
		return raceCancellationError(authorize(), signal);
	}

	private call(request: HostCredentialRequest): Promise<HostCredentialResponse> {
		if (this.isDisposed || this.queued >= 64) { return Promise.reject(unavailable()); }
		this.queued++;
		const generation = this.generation;
		return this.operations.schedule(async () => {
			try {
				if (this.isDisposed || generation !== this.generation || this.state !== 'ready' || !this.process) { throw unavailable(); }
				const pending = new DeferredPromise<HostCredentialResponse>();
				this.pending = pending;
				this.process.stdin.write(JSON.stringify(request) + '\n', error => { if (error && this.pending === pending) { this.disconnect('crashed'); } });
				const timeout = setTimeout(() => { if (this.pending === pending) { this.disconnect('crashed'); } }, 45_000);
				try { return await pending.p; }
				finally { clearTimeout(timeout); }
			} finally { this.queued--; }
		});
	}

	public async stop(): Promise<void> { this.disconnect('stopped'); }

	private disconnect(state: 'stopped' | 'crashed'): void {
		const hadContext = this.context !== undefined;
		this.generation++;
		this.context = undefined;
		this.starting = undefined;
		this.process = undefined;
		const pending = this.pending;
		this.pending = undefined;
		if (this.ready && !this.ready.isSettled) { void this.ready.error(unavailable()); }
		if (pending) { void pending.error(unavailable()); }
		this.revoke();
		this.carrier.clear();
		this.setState(state);
		if (hadContext) { this.changes.fire(undefined); }
	}

	private revoke(): void {
		for (const lease of this.leases.values()) { lease.abort(); }
		this.leases.clear();
	}

	private setState(state: AppServerConnectionState): void { this.state = state; this.states.fire(state); }
}

function unavailable(): ChatGPTAuthenticationError { return new ChatGPTAuthenticationError('ChatGPT authentication owner is unavailable'); }
function validContext(value: string): boolean { return /^[a-f0-9]{32}$/u.test(value); }
function readHeaders(value: Readonly<Record<string, string>>): Headers {
	const headers = new Headers();
	for (const [name, header] of Object.entries(value)) {
		if (!['authorization', 'chatgpt-account-id', 'x-openai-fedramp'].includes(name.toLowerCase()) || !header || header.length > 32768 || /[\r\n\0]/u.test(header)
			|| (name.toLowerCase() === 'x-openai-fedramp' && header !== 'true')) { throw unavailable(); }
		headers.set(name, header);
	}
	if (!headers.get('Authorization')?.startsWith('Bearer ')) { throw unavailable(); }
	return headers;
}
