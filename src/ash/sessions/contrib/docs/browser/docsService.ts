import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { isRecord } from '../../../../base/common/types.js';
import { localize } from '../../../../nls.js';
import { FileKind, FileNotFoundError, FileSystemProviderErrorCode, IFileService, toFileSystemProviderErrorCode } from '../../../../platform/files/common/files.js';
import { artifactSourceKey, type ArtifactResource, type ArtifactRegistration, type ArtifactSource } from '../../../../platform/artifactCatalog/common/artifactCatalog.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IUserDataProfileService } from '../../../../workbench/services/userDataProfile/common/userDataProfile.js';
import { IArtifactCatalogService } from '../../../services/artifactCatalog/common/artifactCatalogService.js';
import { IDocsService } from '../common/docsService.js';

/** Imports Markdown once. The catalog retains metadata; working copies own later edits. */
export class DocsService extends Disposable implements IDocsService {
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private readonly home: URI;
	private readonly pendingHome: URI;
	private readonly publishing = new Map<string, Promise<ArtifactResource>>();
	private recovering: Promise<void> | undefined;
	private failure: string | undefined;
	get error(): string | undefined { return this.failure; }

	constructor(
		@IArtifactCatalogService private readonly catalog: IArtifactCatalogService,
		@IFileService private readonly fileService: IFileService,
		@IUserDataProfileService profiles: IUserDataProfileService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		this.home = URI.joinPath(profiles.currentProfile.location, 'documents');
		this.pendingHome = URI.joinPath(this.home, 'imports');
		this._register(catalog.onDidChange(() => {
			if (!catalog.loading && !catalog.error) void this.recoverPending().catch(error => this.log.warn('Docs import recovery failed', error));
		}));
		// Catalog observers can read Docs while this delayed service is being constructed.
		void Promise.resolve().then(() => this.isDisposed ? undefined : this.recoverImports()).catch(error => this.log.warn('Docs imports could not be restored', error));
	}


	isProfileDocumentPath(resource: URI): boolean {
		return resource.scheme === this.home.scheme && resource.authority === this.home.authority
			&& resource.path.startsWith(this.home.path + '/') && /^[a-f0-9]{64}\.md$/u.test(resource.path.slice(this.home.path.length + 1));
	}

	async recoverImports(): Promise<void> {
		await this.catalog.refresh();
		await this.recoverPending();
	}

	private recoverPending(): Promise<void> {
		if (this.recovering) return this.recovering;
		this.recovering = Promise.resolve().then(async () => {
			if (this.isDisposed) return;
			const pending = await this.retryPublications().catch(error => {
				this.log.warn('Docs import recovery failed', error);
				return true;
			});
			this.failure = pending ? localize({ bundle: 'ash.artifacts', key: 'docsImportsPending' }, 'Some documents could not be registered. Their saved content is retained; reconnect and try again.') : undefined;
			if (!this.isDisposed) this.changed.fire();
		}).finally(() => { this.recovering = undefined; });
		return this.recovering;
	}

	importMarkdown(source: ArtifactSource, markdown: string, title?: string): Promise<ArtifactResource> {
		const key = artifactSourceKey(source);
		const existing = this.catalog.findBySource(source);
		if (existing) return Promise.resolve(existing);
		const inFlight = this.publishing.get(key);
		if (inFlight) return inFlight;
		const publication = this.publish(source, markdown, title).finally(() => this.publishing.delete(key));
		this.publishing.set(key, publication);
		return publication;
	}

	private async publish(source: ArtifactSource, markdown: string, title?: string): Promise<ArtifactResource> {
		if (!markdown.trim()) throw new Error('Cannot import an empty Markdown document');
		const id = await sourceId(source);
		const resource = URI.joinPath(this.home, `${id}.md`);
		const heading = /^#{1,6}\s+(.+?)\s*#*$/mu.exec(markdown)?.[1];
		const label = (title?.replace(/\p{Cc}/gu, ' ').trim() || heading?.replace(/\p{Cc}/gu, ' ').trim() || localize({ bundle: 'ash.artifacts', key: 'document' }, 'Document')).slice(0, 200);
		const registration: ArtifactRegistration = { id, resource, title: label, contentType: 'text/markdown', source };
		// The receipt owns the staged bytes until the create-only file write succeeds.
		// Every interruption can replay this receipt without replacing later user edits.
		await this.fileService.createDirectory(this.pendingHome);
		const receipt = URI.joinPath(this.pendingHome, `${id}.json`);
		await this.createOnce(receipt, JSON.stringify({ ...registration, resource: resource.toString(), markdown }));
		const file = await this.finishReceipt(receipt, id);
		await this.fileService.delete(receipt, 'ignore', 'fileOrEmptyDirectory');
		return file;
	}

	private async createOnce(resource: URI, content: string): Promise<void> {
		try {
			await this.fileService.writeFile({ resource, content }, { create: true, overwrite: false });
		} catch (error) {
			if (toFileSystemProviderErrorCode(error instanceof Error ? error : undefined) !== FileSystemProviderErrorCode.FileExists) throw error;
		}
	}

	private async retryPublications(): Promise<boolean> {
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
				if (!this.catalog.isVisible(file.source)) continue;
				await this.commitReceipt(file, markdown);
				await this.fileService.delete(receipt.resource, 'ignore', 'fileOrEmptyDirectory');
			} catch (error) {
				// One damaged receipt must not hide registered files or block another publication.
				pending = true;
				this.log.warn('Docs import remains pending', receipt.resource.toString(), error);
			}
		}
		return pending;
	}

	private async finishReceipt(receipt: URI, id: string): Promise<ArtifactResource> {
		try {
			const { file, markdown } = await this.readReceipt(receipt, id);
			return await this.commitReceipt(file, markdown);
		} catch (error) {
			// Another window may already have committed and removed the shared receipt.
			if (error instanceof FileNotFoundError) {
				const file = (await this.catalog.refresh().then(() => this.catalog.files)).find(file => file.id === id);
				if (file) return file;
			}
			throw error;
		}
	}

	private async commitReceipt(file: ArtifactRegistration, markdown: string | undefined): Promise<ArtifactResource> {
		if (markdown !== undefined) await this.createOnce(file.resource, markdown);
		const stat = await this.fileService.stat(file.resource);
		if (stat.kind !== FileKind.File) throw new Error('Docs import is not a file');
		return this.catalog.register(file);
	}

	private async readReceipt(receipt: URI, id: string): Promise<{ file: ArtifactRegistration; markdown: string | undefined; }> {
		const value: unknown = JSON.parse((await this.fileService.readFile(receipt)).content);
		if (!isRecord(value) || value.id !== id || value.contentType !== 'text/markdown'
			|| typeof value.title !== 'string' || !value.title.trim() || value.title.length > 200
			|| value.resource !== URI.joinPath(this.home, `${id}.md`).toString() || !isSource(value.source)
			|| value.markdown !== undefined && (typeof value.markdown !== 'string' || !value.markdown.trim())
			|| await sourceId(value.source) !== id) throw new Error('Invalid Docs import receipt');
		return { file: { id, title: value.title, contentType: value.contentType, resource: URI.parse(value.resource), source: value.source }, markdown: value.markdown };
	}

}

async function sourceId(source: ArtifactSource): Promise<string> {
	const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(artifactSourceKey(source)));
	return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

function isSource(value: unknown): value is ArtifactSource {
	return isRecord(value) && ['providerId', 'sessionId', 'threadId', 'itemId', 'partId'].every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 4096)
		&& (value.accountId === null || typeof value.accountId === 'string' && value.accountId.length > 0 && value.accountId.length <= 4096);
}
