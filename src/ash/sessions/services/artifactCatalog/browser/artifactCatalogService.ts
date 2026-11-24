import { resolveArtifactCatalogIdentity } from './artifactCatalogIdentity.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, derived, observableValue, type IObservable } from '../../../../base/common/observable.js';
import type { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IAgentConnection } from '../../../../platform/agentHost/common/agentService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { artifactSourceKey, type ArtifactResource, type ArtifactRegistration, type ArtifactSource, type IArtifactCatalog } from '../../../../platform/artifactCatalog/common/artifactCatalog.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IUserDataProfileService } from '../../../../workbench/services/userDataProfile/common/userDataProfile.js';
import type { IArtifactCatalogService } from '../common/artifactCatalogService.js';

const noSessionFiles: readonly ArtifactResource[] = Object.freeze([]);

function sessionKey(source: Pick<ArtifactSource, 'providerId' | 'accountId' | 'sessionId'>): string {
	return JSON.stringify([source.providerId, source.accountId, source.sessionId]);
}

function sameFile(left: ArtifactResource, right: ArtifactResource): boolean {
	return left === right || left.id === right.id && left.title === right.title && left.contentType === right.contentType
		&& left.createdAt === right.createdAt && left.resource.toString() === right.resource.toString()
		&& artifactSourceKey(left.source) === artifactSourceKey(right.source);
}

/** Observable profile catalog. Registering metadata never creates or saves content. */
export class ArtifactCatalogService extends Disposable implements IArtifactCatalogService {
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private readonly entries = observableValue<readonly ArtifactResource[]>(this, []);
	private readonly sessionFiles = observableValue<ReadonlyMap<string, readonly ArtifactResource[]>>(this, new Map());
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
			this.indexSessionFiles(this.entries.get());
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

	observeSessionFiles(source: Pick<ArtifactSource, 'providerId' | 'accountId' | 'sessionId'>): IObservable<readonly ArtifactResource[]> {
		const key = sessionKey(source);
		return derived(reader => this.sessionFiles.read(reader).get(key) ?? noSessionFiles);
	}

	private indexSessionFiles(files: readonly ArtifactResource[]): void {
		const groups = new Map<string, ArtifactResource[]>();
		const accounts = new Set([...this.accounts].map(scope => scope.get()));
		for (const file of files) {
			if (file.source.accountId !== null && !accounts.has(file.source.accountId)) continue;
			const key = sessionKey(file.source);
			const group = groups.get(key);
			if (group) group.push(file);
			else groups.set(key, [file]);
		}
		const previous = this.sessionFiles.get();
		const indexed = new Map<string, readonly ArtifactResource[]>();
		let changed = groups.size !== previous.size;
		for (const [key, group] of groups) {
			const old = previous.get(key);
			if (old && old.length === group.length && group.every((file, index) => sameFile(file, old[index]!))) {
				indexed.set(key, old);
			} else {
				indexed.set(key, group);
				changed = true;
			}
		}
		if (changed) this.sessionFiles.set(indexed, undefined);
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
			this.indexSessionFiles(files);
			this.failure.set(undefined, undefined);
		} while (this.invalidated && !this.isDisposed);
	}

	async register(registration: ArtifactRegistration): Promise<ArtifactResource> {
		const file = await this.requireCatalog().register(await this.getClientId(), registration);
		if (!this.isDisposed) {
			this.invalidated = true;
			const files = [...this.entries.get().filter(entry => entry.id !== file.id), file];
			this.entries.set(files, undefined);
			this.indexSessionFiles(files);
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
