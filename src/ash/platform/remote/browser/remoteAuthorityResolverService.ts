import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { URI } from '../../../base/common/uri.js';
import { RemoteAuthorityResolverError, RemoteAuthorityResolverErrorCode, type IRemoteAuthorityResolverService, type IRemoteConnectionData, type ResolvedAuthority, type ResolvedOptions, type ResolverResult } from '../common/remoteAuthorityResolver.js';

/** Web uses host-published addresses and keeps resource identity without a local extension host. */
export class RemoteAuthorityResolverService extends Disposable implements IRemoteAuthorityResolverService {
	declare readonly _serviceBrand: undefined;
	private readonly changes = this._register(new Emitter<void>());
	public readonly onDidChangeConnectionData = this.changes.event;
	private readonly results = new Map<string, ResolverResult>();
	private readonly errors = new Map<string, unknown>();
	private canonicalProvider: ((uri: URI) => Promise<URI>) | undefined;

	constructor() {
		super();
		this._register(toDisposable(() => {
			this.results.clear();
			this.errors.clear();
			this.canonicalProvider = undefined;
		}));
	}

	public resolveAuthority(authority: string): Promise<ResolverResult> {
		this.assertNotDisposed();
		if (this.errors.has(authority)) { return Promise.reject(this.errors.get(authority)); }
		const result = this.results.get(authority);
		return result ? Promise.resolve(result) : Promise.reject(new RemoteAuthorityResolverError('No Web host has resolved this authority', RemoteAuthorityResolverErrorCode.NoResolverFound));
	}

	public getCanonicalURI(uri: URI): Promise<URI> {
		this.assertNotDisposed();
		return this.canonicalProvider ? this.canonicalProvider(uri) : Promise.resolve(uri);
	}

	public getConnectionData(authority: string): IRemoteConnectionData | null {
		const resolved = this.results.get(authority)?.authority;
		return resolved ? { connectTo: resolved.connectTo, connectionToken: resolved.connectionToken } : null;
	}

	public _setResolvedAuthority(authority: ResolvedAuthority, options?: ResolvedOptions): void {
		this.assertNotDisposed();
		this.results.set(authority.authority, options === undefined ? { authority } : { authority, options });
		this.errors.delete(authority.authority);
		this.changes.fire();
	}

	public _setResolvedAuthorityError(authority: string, error: unknown): void {
		this.assertNotDisposed();
		this.results.delete(authority);
		this.errors.set(authority, error);
		this.changes.fire();
	}

	public _clearResolvedAuthority(authority: string): void {
		this.assertNotDisposed();
		this.results.delete(authority);
		this.errors.delete(authority);
		this.changes.fire();
	}

	public _setCanonicalURIProvider(provider: (uri: URI) => Promise<URI>): void {
		this.assertNotDisposed();
		this.canonicalProvider = provider;
	}
}
