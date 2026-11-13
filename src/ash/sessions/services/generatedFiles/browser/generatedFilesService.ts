import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableValue, type IObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid, isUuid } from '../../../../base/common/uuid.js';
import { isRecord } from '../../../../base/common/types.js';
import { localize } from '../../../../nls.js';
import { IAgentConnection } from '../../../../platform/agentHost/common/agentService.js';
import { FileKind, FileNotFoundError, FileSystemProviderErrorCode, IFileService, toFileSystemProviderErrorCode } from '../../../../platform/files/common/files.js';
import { generatedFileSourceKey, type GeneratedFile, type GeneratedFileRegistration, type GeneratedFileSource, type IGeneratedFileCatalog } from '../../../../platform/generatedFiles/common/generatedFiles.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IUserDataProfileService } from '../../../../workbench/services/userDataProfile/common/userDataProfile.js';
import type { IGeneratedFilesService } from '../common/generatedFilesService.js';

/** Coordinates publication, without retaining document bodies after their initial write. */
export class GeneratedFilesService extends Disposable implements IGeneratedFilesService {
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private readonly entries = observableValue<readonly GeneratedFile[]>(this, []);
	private readonly busy = observableValue(this, false);
	private readonly failure = observableValue<string | undefined>(this, undefined);
	private readonly home: URI;
	private readonly pendingHome: URI;
	private readonly catalog: IGeneratedFileCatalog | undefined;
	private clientId: Promise<string> | undefined;
	private refreshing: Promise<void> | undefined;
	private invalidated = false;
	private readonly publishing = new Map<string, Promise<GeneratedFile>>();
	private readonly accounts = new Set<IObservable<string | undefined>>();

	get files(): readonly GeneratedFile[] { return this.entries.get().filter(file => this.canSee(file.source)); }
	get loading(): boolean { return this.busy.get(); }
	get error(): string | undefined { return this.failure.get(); }

	constructor(
		@IAgentConnection connection: IAgentConnection,
		@IFileService private readonly fileService: IFileService,
		@IUserDataProfileService profiles: IUserDataProfileService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		this.home = URI.joinPath(profiles.currentProfile.location, 'generated-files');
		this.pendingHome = URI.joinPath(this.home, 'pending');
		this.catalog = connection.generatedFiles;
		if (this.catalog) this._register(this.catalog.onDidChange(() => {
			this.invalidated = true;
			void this.refresh().catch(error => this.log.warn('Generated files refresh failed', error));
		}));
		if (this.catalog) void this.refresh().catch(error => this.log.warn('Generated files could not be loaded', error));
	}

	trackAccount(scope: IObservable<string | undefined>): IDisposable {
		this.accounts.add(scope);
		const update = () => {
			this.invalidated = true;
			this.changed.fire();
			if (this.catalog) void this.refresh().catch(error => this.log.warn('Generated files account refresh failed', error));
		};
		const subscription = autorun(reader => { scope.read(reader); update(); });
		return toDisposable(() => {
			subscription.dispose();
			this.accounts.delete(scope);
			update();
		});
	}

	private canSee(source: GeneratedFileSource): boolean {
		return source.accountId === null || [...this.accounts].some(scope => scope.get() === source.accountId);
	}

	isProfileGeneratedPath(resource: URI): boolean {
		return resource.scheme === this.home.scheme && resource.authority === this.home.authority
			&& resource.path.startsWith(this.home.path + '/') && /^[a-f0-9]{64}\.md$/u.test(resource.path.slice(this.home.path.length + 1));
	}

	findBySource(source: GeneratedFileSource): GeneratedFile | undefined {
		const key = generatedFileSourceKey(source);
		return this.files.find(file => generatedFileSourceKey(file.source) === key);
	}

	isGeneratedResource(resource: URI): boolean {
		return this.files.some(file => file.resource.toString() === resource.toString());
	}

	refresh(): Promise<void> {
		if (this.refreshing) return this.refreshing;
		this.refreshing = Promise.resolve().then(() => this.load()).catch(error => {
			this.failure.set(localize({ bundle: 'ash.artifacts', key: 'generatedFilesLoadFailed' }, 'Generated files could not be loaded. Reconnect and try again.'), undefined);
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
			// Publication receipts survive disconnect and restart; they are removed only after registration.
			const pending = await this.retryPublications(catalog, clientId).catch(error => {
				this.log.warn('Generated file publication recovery failed', error);
				return true;
			});
			const files = await catalog.list(clientId, [...this.accounts].flatMap(scope => scope.get() ?? []));
			if (this.isDisposed) return;
			this.entries.set(files, undefined);
			this.failure.set(pending ? localize({ bundle: 'ash.artifacts', key: 'generatedFilesPending' }, 'Some generated files could not be registered. Their saved content is retained; reconnect and try again.') : undefined, undefined);
		} while (this.invalidated && !this.isDisposed);
	}

	publishMarkdown(source: GeneratedFileSource, markdown: string, title?: string): Promise<GeneratedFile> {
		const key = generatedFileSourceKey(source);
		const existing = this.findBySource(source);
		if (existing) return Promise.resolve(existing);
		const inFlight = this.publishing.get(key);
		if (inFlight) return inFlight;
		const publication = this.publish(source, markdown, title).finally(() => this.publishing.delete(key));
		this.publishing.set(key, publication);
		return publication;
	}

	private async publish(source: GeneratedFileSource, markdown: string, title?: string): Promise<GeneratedFile> {
		if (!markdown.trim()) throw new Error('Cannot publish an empty Markdown document');
		const catalog = this.requireCatalog();
		const clientId = await this.getClientId();
		const id = await sourceId(source);
		const resource = URI.joinPath(this.home, `${id}.md`);
		const heading = /^#{1,6}\s+(.+?)\s*#*$/mu.exec(markdown)?.[1];
		const label = (title?.replace(/\p{Cc}/gu, ' ').trim() || heading?.replace(/\p{Cc}/gu, ' ').trim() || localize({ bundle: 'ash.artifacts', key: 'generatedDocument' }, 'Generated document')).slice(0, 200);
		const registration: GeneratedFileRegistration = { id, resource, title: label, contentType: 'text/markdown', source };
		// The receipt owns the staged bytes until the create-only file write succeeds.
		// Every interruption can replay this receipt without replacing later user edits.
		await this.fileService.createDirectory(this.pendingHome);
		const receipt = URI.joinPath(this.pendingHome, `${id}.json`);
		await this.createOnce(receipt, JSON.stringify({ ...registration, resource: resource.toString(), markdown }));
		const file = await this.finishReceipt(catalog, clientId, receipt, id);
		await this.fileService.delete(receipt, 'ignore', 'fileOrEmptyDirectory');
		if (!this.isDisposed) {
			this.invalidated = true;
			this.entries.set([...this.entries.get().filter(entry => entry.id !== file.id), file], undefined);
			this.changed.fire();
		}
		return file;
	}

	private async createOnce(resource: URI, content: string): Promise<void> {
		try {
			await this.fileService.writeFile({ resource, content }, { create: true, overwrite: false });
		} catch (error) {
			if (toFileSystemProviderErrorCode(error instanceof Error ? error : undefined) !== FileSystemProviderErrorCode.FileExists) throw error;
		}
	}

	private async retryPublications(catalog: IGeneratedFileCatalog, clientId: string): Promise<boolean> {
		const receipts = await this.fileService.readDirectory(this.pendingHome).catch(error => {
			if (error instanceof FileNotFoundError) return [];
			throw error;
		});
		let pending = false;
		for (const receipt of receipts) {
			if (this.isDisposed) return pending;
			if (receipt.kind !== FileKind.File || !/^[a-f0-9]{64}\.json$/u.test(receipt.name)) continue;
			try {
				const id = receipt.name.slice(0, -5);
				const { file, markdown } = await this.readReceipt(receipt.resource, id);
				if (!this.canSee(file.source)) continue;
				await this.commitReceipt(catalog, clientId, file, markdown);
				await this.fileService.delete(receipt.resource, 'ignore', 'fileOrEmptyDirectory');
			} catch (error) {
				// One damaged receipt must not hide registered files or block another publication.
				pending = true;
				this.log.warn('Generated file publication remains pending', receipt.resource.toString(), error);
			}
		}
		return pending;
	}

	private async finishReceipt(catalog: IGeneratedFileCatalog, clientId: string, receipt: URI, id: string): Promise<GeneratedFile> {
		try {
			const { file, markdown } = await this.readReceipt(receipt, id);
			return await this.commitReceipt(catalog, clientId, file, markdown);
		} catch (error) {
			// Another window may already have committed and removed the shared receipt.
			if (error instanceof FileNotFoundError) {
				const file = (await catalog.list(clientId, [...this.accounts].flatMap(scope => scope.get() ?? []))).find(file => file.id === id);
				if (file) return file;
			}
			throw error;
		}
	}

	private async commitReceipt(catalog: IGeneratedFileCatalog, clientId: string, file: GeneratedFileRegistration, markdown: string | undefined): Promise<GeneratedFile> {
		if (markdown !== undefined) await this.createOnce(file.resource, markdown);
		const stat = await this.fileService.stat(file.resource);
		if (stat.kind !== FileKind.File) throw new Error('Generated file publication is not a file');
		return catalog.register(clientId, file);
	}

	private async readReceipt(receipt: URI, id: string): Promise<{ file: GeneratedFileRegistration; markdown: string | undefined; }> {
		const value: unknown = JSON.parse((await this.fileService.readFile(receipt)).content);
		if (!isRecord(value) || value.id !== id || value.contentType !== 'text/markdown'
			|| typeof value.title !== 'string' || !value.title.trim() || value.title.length > 200
			|| value.resource !== URI.joinPath(this.home, `${id}.md`).toString() || !isSource(value.source)
			|| value.markdown !== undefined && (typeof value.markdown !== 'string' || !value.markdown.trim())
			|| await sourceId(value.source) !== id) throw new Error('Invalid generated file publication receipt');
		return { file: { id, title: value.title, contentType: value.contentType, resource: URI.parse(value.resource), source: value.source }, markdown: value.markdown };
	}

	private getClientId(): Promise<string> {
		if (!this.clientId) this.clientId = this.resolveClientId().catch(error => { this.clientId = undefined; throw error; });
		return this.clientId;
	}

	private async resolveClientId(): Promise<string> {
		await this.fileService.createDirectory(this.home);
		const resource = URI.joinPath(this.home, 'client-id');
		await this.createOnce(resource, generateUuid());
		const id = (await this.fileService.readFile(resource)).content;
		if (!isUuid(id)) throw new Error('Invalid generated files client identity');
		return id;
	}

	private requireCatalog(): IGeneratedFileCatalog {
		if (!this.catalog) throw new Error(localize({ bundle: 'ash.artifacts', key: 'generatedFilesUnavailable' }, 'Generated files are unavailable on this host.'));
		return this.catalog;
	}
}

async function sourceId(source: GeneratedFileSource): Promise<string> {
	const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(generatedFileSourceKey(source)));
	return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

function isSource(value: unknown): value is GeneratedFileSource {
	return isRecord(value) && ['providerId', 'sessionId', 'threadId', 'itemId', 'partId'].every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 4096)
		&& (value.accountId === null || typeof value.accountId === 'string' && value.accountId.length > 0 && value.accountId.length <= 4096);
}
