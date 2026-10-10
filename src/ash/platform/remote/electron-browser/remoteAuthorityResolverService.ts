import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { DeferredPromise } from '../../../base/common/async.js';
import { CancellationError } from '../../../base/common/errors.js';
import { URI } from '../../../base/common/uri.js';
import { Schemas } from '../../../base/common/network.js';
import { type IRemoteAuthorityResolverService, type IRemoteConnectionData, type ResolvedAuthority, type ResolvedOptions, type ResolverResult } from '../common/remoteAuthorityResolver.js';

/** A window owns the published address and any callers waiting for its local resolver. */
export class RemoteAuthorityResolverService extends Disposable implements IRemoteAuthorityResolverService {
	declare readonly _serviceBrand: undefined;
	private readonly changes = this._register(new Emitter<void>());
	public readonly onDidChangeConnectionData = this.changes.event;
	private readonly results = new Map<string, ResolverResult>();
	private readonly pending = new Map<string, DeferredPromise<ResolverResult>>();
	private readonly errors = new Map<string, unknown>();
	private readonly canonical = new Map<string, { uri: URI; result: DeferredPromise<URI>; started: boolean; }>();
	private canonicalProvider: ((uri: URI) => Promise<URI>) | undefined;
	private providerRevision = 0;

	constructor() {
		super();
		this._register(toDisposable(() => {
			for (const request of this.pending.values()) { void request.error(new CancellationError()); }
			this.pending.clear();
			this.results.clear();
			this.errors.clear();
			this.providerRevision++;
			this.canonicalProvider = undefined;
			for (const request of this.canonical.values()) { void request.result.error(new CancellationError()); }
			this.canonical.clear();
		}));
	}

	public resolveAuthority(authority: string): Promise<ResolverResult> {
		this.assertNotDisposed();
		if (this.errors.has(authority)) { return Promise.reject(this.errors.get(authority)); }
		const result = this.results.get(authority);
		if (result) { return Promise.resolve(result); }
		let request = this.pending.get(authority);
		if (!request) {
			request = new DeferredPromise<ResolverResult>();
			this.pending.set(authority, request);
		}
		return request.p;
	}

	public getConnectionData(authority: string): IRemoteConnectionData | null {
		const result = this.results.get(authority)?.authority;
		return result ? { connectTo: result.connectTo, connectionToken: result.connectionToken } : null;
	}

	public getCanonicalURI(uri: URI): Promise<URI> {
		this.assertNotDisposed();
		if (uri.scheme !== Schemas.ashRemote) { return Promise.resolve(uri); }
		const key = uri.toString();
		let request = this.canonical.get(key);
		if (!request) {
			// Bound successful identities without dropping a caller still waiting for its provider.
			if (this.canonical.size >= 256) {
				const settled = [...this.canonical].find(([, entry]) => entry.result.isSettled);
				if (!settled) { return Promise.reject(new Error('Canonical URI request quota exceeded')); }
				this.canonical.delete(settled[0]);
			}
			request = { uri, result: new DeferredPromise<URI>(), started: false };
			this.canonical.set(key, request);
		}
		this.startCanonicalRequest(key, request);
		return request.result.p;
	}

	public _setCanonicalURIProvider(provider: (uri: URI) => Promise<URI>): void {
		this.assertNotDisposed();
		this.providerRevision++;
		if (this.canonicalProvider) {
			for (const request of this.canonical.values()) { void request.result.error(new CancellationError()); }
			this.canonical.clear();
		}
		this.canonicalProvider = provider;
		for (const [key, request] of this.canonical) { this.startCanonicalRequest(key, request); }
	}

	private startCanonicalRequest(key: string, request: { uri: URI; result: DeferredPromise<URI>; started: boolean; }): void {
		const provider = this.canonicalProvider;
		if (!provider || request.started) { return; }
		request.started = true;
		const revision = this.providerRevision;
		void Promise.resolve().then(() => provider(request.uri)).then(uri => {
			if (revision === this.providerRevision && this.canonical.get(key) === request) { void request.result.complete(uri); }
		}, error => {
			if (revision === this.providerRevision && this.canonical.get(key) === request) {
				this.canonical.delete(key);
				void request.result.error(error);
			}
		});
	}

	public _clearResolvedAuthority(authority: string): void {
		this.assertNotDisposed();
		const request = this.pending.get(authority);
		this.pending.delete(authority);
		this.results.delete(authority);
		this.errors.delete(authority);
		for (const [key, entry] of this.canonical) {
			if (entry.uri.authority === authority) {
				this.canonical.delete(key);
				void entry.result.error(new CancellationError());
			}
		}
		if (request) { void request.error(new CancellationError()); }
		this.changes.fire();
	}

	public _setResolvedAuthority(authority: ResolvedAuthority, options?: ResolvedOptions): void {
		this.assertNotDisposed();
		const result: ResolverResult = options === undefined ? { authority } : { authority, options };
		this.results.set(authority.authority, result);
		this.errors.delete(authority.authority);
		const request = this.pending.get(authority.authority);
		this.pending.delete(authority.authority);
		if (request) { void request.complete(result); }
		this.changes.fire();
	}

	public _setResolvedAuthorityError(authority: string, error: unknown): void {
		this.assertNotDisposed();
		this.results.delete(authority);
		this.errors.set(authority, error);
		const request = this.pending.get(authority);
		this.pending.delete(authority);
		if (request) { void request.error(error); }
		this.changes.fire();
	}
}
