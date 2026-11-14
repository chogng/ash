import { resolveArtifactCatalogIdentity } from './artifactCatalogIdentity.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableValue, type IObservable } from '../../../../base/common/observable.js';
import type { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IAgentConnection } from '../../../../platform/agentHost/common/agentService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { artifactSourceKey, type ArtifactResource, type ArtifactRegistration, type ArtifactSource, type IArtifactCatalog } from '../../../../platform/artifactCatalog/common/artifactCatalog.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IUserDataProfileService } from '../../../../workbench/services/userDataProfile/common/userDataProfile.js';
import type { IArtifactCatalogService } from '../common/artifactCatalogService.js';

/** Observable profile catalog. Registering metadata never creates or saves content. */
export class ArtifactCatalogService extends Disposable implements IArtifactCatalogService {
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private readonly entries = observableValue<readonly ArtifactResource[]>(this, []);
	private readonly busy = observableValue(this, false);
	private readonly failure = observableValue<string | undefined>(this, undefined);
	private readonly profileLocation: URI;
	private readonly catalog: IArtifactCatalog | undefined;
	private clientId: Promise<string> | undefined;
	private refreshing: Promise<void> | undefined;
	private invalidated = false;
	private readonly accounts = new Set<IObservable<string | undefined>>();

	get files(): readonly ArtifactResource[] { return this.entries.get().filter(file => this.isVisible(file.source)); }
	get loading(): boolean { return this.busy.get(); }
	get error(): string | undefined { return this.failure.get(); }

	constructor(
		@IAgentConnection connection: IAgentConnection,
		@IFileService private readonly fileService: IFileService,
		@IUserDataProfileService profiles: IUserDataProfileService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		this.profileLocation = profiles.currentProfile.location;
		this.catalog = connection.artifactCatalog;
		if (this.catalog) this._register(this.catalog.onDidChange(() => {
			this.invalidated = true;
			void this.refresh().catch(error => this.log.warn('Artifact catalog refresh failed', error));
		}));
		// Observers may already hold the delayed service proxy. Publish only after construction completes.
		if (this.catalog) void Promise.resolve().then(() => this.isDisposed ? undefined : this.refresh()).catch(error => this.log.warn('Artifact catalog could not be loaded', error));
	}

	trackAccount(scope: IObservable<string | undefined>): IDisposable {
		this.accounts.add(scope);
		const update = () => {
			this.invalidated = true;
			this.changed.fire();
			if (this.catalog) void this.refresh().catch(error => this.log.warn('Artifact account refresh failed', error));
		};
		const subscription = autorun(reader => { scope.read(reader); update(); });
		return toDisposable(() => {
			subscription.dispose();
			this.accounts.delete(scope);
			update();
		});
	}

	isVisible(source: ArtifactSource): boolean {
		return source.accountId === null || [...this.accounts].some(scope => scope.get() === source.accountId);
	}

	findBySource(source: ArtifactSource): ArtifactResource | undefined {
		const key = artifactSourceKey(source);
		return this.files.find(file => artifactSourceKey(file.source) === key);
	}

	hasResource(resource: URI): boolean {
		return this.files.some(file => file.resource.toString() === resource.toString());
	}


	refresh(): Promise<void> {
		if (this.refreshing) return this.refreshing;
		this.refreshing = Promise.resolve().then(() => this.load()).catch(error => {
			this.failure.set(localize({ bundle: 'ash.artifacts', key: 'artifactCatalogLoadFailed' }, 'Artifacts could not be loaded. Reconnect and try again.'), undefined);
			throw error;
		}).finally(() => {
			this.refreshing = undefined;
			this.busy.set(false, undefined);
			if (!this.isDisposed) this.changed.fire();
		});
		this.busy.set(true, undefined);
		this.changed.fire();
		return this.refreshing;
	}

	private async load(): Promise<void> {
		const catalog = this.requireCatalog();
		const clientId = await this.getClientId();
		do {
			this.invalidated = false;
			const files = await catalog.list(clientId, [...this.accounts].flatMap(scope => scope.get() ?? []));
			if (this.isDisposed) return;
			this.entries.set(files, undefined);
			this.failure.set(undefined, undefined);
		} while (this.invalidated && !this.isDisposed);
	}

	async register(registration: ArtifactRegistration): Promise<ArtifactResource> {
		const file = await this.requireCatalog().register(await this.getClientId(), registration);
		if (!this.isDisposed) {
			this.invalidated = true;
			this.entries.set([...this.entries.get().filter(entry => entry.id !== file.id), file], undefined);
			this.changed.fire();
		}
		return file;
	}

	private getClientId(): Promise<string> {
		if (!this.clientId) this.clientId = resolveArtifactCatalogIdentity(this.fileService, this.profileLocation).catch(error => { this.clientId = undefined; throw error; });
		return this.clientId;
	}

	private requireCatalog(): IArtifactCatalog {
		if (!this.catalog) throw new Error(localize({ bundle: 'ash.artifacts', key: 'artifactCatalogUnavailable' }, 'Artifacts are unavailable on this host.'));
		return this.catalog;
	}
}
