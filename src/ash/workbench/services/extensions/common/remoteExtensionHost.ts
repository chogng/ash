import { DeferredPromise } from '../../../../base/common/async.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IExtensionHostApi, type ExtensionHostFleetSnapshot } from '../../../../platform/extensionHost/common/extensionHostApi.js';
import { IRemoteAuthorityResolverService } from '../../../../platform/remote/common/remoteAuthorityResolver.js';

/** Owns remote extension startup readiness; Rust owns the connection's executable processes. */
export class RemoteExtensionHost extends Disposable {
	private readiness = new DeferredPromise<void>();
	private revision = 0;

	constructor(private readonly authority: string, @IExtensionHostApi public readonly api: IExtensionHostApi,
		@IRemoteAuthorityResolverService private readonly resolver: IRemoteAuthorityResolverService,
	) {
		super();
		void this.readiness.p.catch(() => undefined);
		const connection = api.onConnectionState(state => {
			if (state !== 'ready') { this.retire(); }
		});
		this._register(toDisposable(() => connection.dispose()));
		this._register(toDisposable(() => this.retire()));
	}

	public async start(): Promise<ExtensionHostFleetSnapshot> {
		this.assertNotDisposed();
		const revision = ++this.revision;
		try {
			const result = await this.resolver.resolveAuthority(this.authority);
			if (this.isDisposed || revision !== this.revision) { throw new CancellationError(); }
			const snapshot = await this.api.start(result.options?.extensionHostEnv ?? {});
			if (this.isDisposed || revision !== this.revision) { throw new CancellationError(); }
			await this.readiness.complete();
			return snapshot;
		} catch (error) {
			if (revision === this.revision) { await this.readiness.error(error); }
			throw error;
		}
	}

	public get isReady(): boolean { return !this.isDisposed && this.readiness.isResolved; }

	public whenReady(): Promise<void> { this.assertNotDisposed(); return this.readiness.p; }

	private retire(): void {
		this.revision++;
		void this.readiness.error(new CancellationError());
		this.readiness = new DeferredPromise<void>();
		void this.readiness.p.catch(() => undefined);
	}
}
