import { loadDesignVectorGeometry, isDesignVectorGeometryReady } from './designVectorGeometry.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { measureDesignText, clearDesignTextMeasurements } from './designTextMeasurement.js';
import { CreatorMode, getCreatorModeTitle } from '../common/creator.js';
import { Emitter } from '../../../../base/common/event.js';
import { decodeBase64 } from '../../../../base/common/buffer.js';
import { isRecord } from '../../../../base/common/types.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename, dirname, extUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ConfirmResult, IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { FileKind, FileNotFoundError, IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { documentFromShapes, flattenDesignShapes, parseDesignDocument, serializeDesignDocument, type DesignAssetVersion, type DesignDocument, type DesignShape } from '../common/model/document.js';
import { DocumentCommands } from '../common/commands/documentCommands.js';
import type { DesignPoint } from '../common/core/geometry.js';
import { encodeDesignMedia, hashDesignMedia, type DesignImageSource } from './designMedia.js';
import { IAssetService, type AssetVersion } from '../../../../platform/assets/common/assetService.js';
import { DesignModel } from '../common/model/designModel.js';
import { emptyDesignResources, getDesignResourceCatalog, getDesignLibraryShapes, type DesignLibrary } from '../common/model/designResources.js';
import { exportDesignSvg } from './svgRenderer.js';
import type { IWorkingCopy } from '../../../../workbench/services/workingCopy/common/workingCopyService.js';

/** Each workspace owns its file identity and saved revision independently of the active canvas. */
export class DesignDocumentController extends Disposable implements IWorkingCopy {
	public readonly resource: URI;
	public readonly backupKind = 'structuredDocument' as const;
	public readonly backupContentType = 'application/vnd.ash.design+json';
	private externalChange = false;
	private readonly externalChangeEmitter = this._register(new Emitter<void>());
	public readonly onDidChangeExternalChange = this.externalChangeEmitter.event;
	public get hasExternalChange(): boolean { return this.externalChange; }
	private media = new Map<string, Uint8Array>();
	public readonly model: DesignModel;
	private readonly changeEmitter = this._register(new Emitter<{ readonly message?: string; }>());
	public readonly onDidChange = this.changeEmitter.event;
	private readonly labelChange = this._register(new Emitter<void>());
	public readonly onDidChangeLabel = this.labelChange.event;
	private readonly dirtyChange = this._register(new Emitter<void>());
	private readonly contentChange = this._register(new Emitter<void>());
	public readonly onDidChangeContent = this.contentChange.event;
	public readonly onDidChangeDirty = this.dirtyChange.event;
	private file: { resource: URI; revision: string; } | undefined;
	private savedContent: string;
	private isFileOperationRunning = false;
	private publication: { readonly documentId: string; readonly resource: URI; } | undefined;
	private readonly libraryUpdates = new Map<string, { readonly library: DesignLibrary; readonly baseVersion: string; readonly media: ReadonlyMap<string, Uint8Array>; }>();
	public getLibraryUpdate(id: string): DesignLibrary | undefined {
		const pending = this.libraryUpdates.get(id);
		return pending?.baseVersion === this.model.value.resources?.libraries.find(library => library.id === id)?.version ? pending?.library : undefined;
	}

	constructor(
		public readonly mode: CreatorMode,
		@IFileService private readonly files: IFileService,
		@IAssetService private readonly assets: IAssetService,
		@IFileDialogService private readonly fileDialogs: IFileDialogService,
		@IDialogService private readonly dialogs: IDialogService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) {
		super();
		this.resource = URI.from({ scheme: 'ash-creator', path: `/${mode}` });
		this.model = this._register(new DesignModel(mode, measureDesignText));
		if (mainWindow.document.fonts) { this._register(addDisposableListener(mainWindow.document.fonts, 'loadingdone', () => { clearDesignTextMeasurements(); this.model.refreshTextLayout(); })); }
		this.savedContent = serializeDesignDocument(this.model.value);
		this._register(this.model.onDidChange(kind => { if (kind === 'replace') { this.libraryUpdates.clear(); } if (!isDesignVectorGeometryReady() && flattenDesignShapes(this.model.value.shapes).some(shape => shape.kind === 'group' && shape.booleanOperation)) { void loadDesignVectorGeometry().then(() => { if (!this.isDisposed) { this.changeEmitter.fire({}); } }, error => { if (!this.isDisposed) { this.changeEmitter.fire({ message: String(error) }); } }); } this.contentChange.fire(); this.dirtyChange.fire(); }));
		this._register(this.onDidChange(() => this.dirtyChange.fire()));
		this._register(files.onDidChangeFiles(() => { void this.checkExternalChange(); }));
		this._register(toDisposable(() => this.media.clear()));
	}

	public get name(): string {
		if (this.file) { return basename(this.file.resource); }
		return this.mode === CreatorMode.Design ? localize('sessions.design.untitled', 'Untitled design') : localize('sessions.creator.untitled', 'Untitled {0}', getCreatorModeTitle(this.mode));
	}
	public get isBusy(): boolean { return this.isFileOperationRunning; }
	public get isDirty(): boolean { return serializeDesignDocument(this.model.value) !== this.savedContent; }
	public backup(): string {
		const document = this.model.value;
		return JSON.stringify({ manifest: serializeDesignDocument(document), media: Object.fromEntries(document.assets.flatMap(asset => asset.versions.map(version => [version.sha256, encodeDesignMedia(this.readMedia(version))]))) });
	}
	public restoreBackup(content: string): void {
		const value: unknown = JSON.parse(content);
		if (!isRecord(value) || typeof value.manifest !== 'string' || !isRecord(value.media) || Object.keys(value).some(key => key !== 'manifest' && key !== 'media')) { throw new TypeError(localize('sessions.design.invalidBackup', 'Invalid design backup')); }
		const document = parseDesignDocument(value.manifest);
		if (document.mode !== this.mode) { throw new TypeError(localize('sessions.creator.wrongMode', 'This document belongs to {0}. Open it in that Creator mode.', getCreatorModeTitle(document.mode))); }
		const media = new Map<string, Uint8Array>();
		for (const asset of document.assets) {
			for (const version of asset.versions) {
				const encoded = value.media[version.sha256];
				if (typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded) || encoded.length === 0) { throw new TypeError(localize('sessions.design.backupMediaMissing', 'Missing design backup media')); }
				media.set(version.sha256, decodeBase64(encoded).buffer);
			}
		}
		// The persisted baseline and its media remain available to Revert after backup recovery.
		for (const [key, bytes] of media) { this.media.set(key, bytes); }
		this.model.replace(document);
	}

	public readMedia(version: DesignAssetVersion): Uint8Array {
		const bytes = this.media.get(version.sha256);
		if (!bytes) { throw new Error(localize('sessions.design.mediaMissing', 'Image data is missing: {0}', version.path)); }
		return bytes;
	}

	public getEmbeddedImageSources(document: DesignDocument = this.model.value, media: ReadonlyMap<string, Uint8Array> = this.media): ReadonlyMap<string, DesignImageSource> {
		const sources = new Map<string, DesignImageSource>();
		for (const shape of flattenDesignShapes(document.shapes)) {
			if (shape.kind !== 'image') { continue; }
			const version = document.assets.find(asset => asset.id === shape.assetId)!.versions.find(version => version.id === shape.assetVersionId)!;
			sources.set(version.id, { url: `data:${version.mediaType};base64,${encodeDesignMedia(media.get(version.sha256) ?? this.readMedia(version))}`, width: version.width, height: version.height });
		}
		return sources;
	}

	public getLibraryImageSources(library: DesignLibrary): ReadonlyMap<string, DesignImageSource> {
		const pending = this.libraryUpdates.get(library.id);
		return this.getEmbeddedImageSources(library.document, pending?.library.version === library.version ? pending.media : this.media);
	}

	public async importImage(center: DesignPoint): Promise<string | undefined> {
		if (this.isBusy) { return undefined; }
		this.isFileOperationRunning = true;
		this.changeEmitter.fire({});
		const versionToken = this.model.version;
		try {
			const resources = await this.fileDialogs.showOpenDialog({ title: localize('sessions.design.importImage', 'Import image'), canSelectFiles: true, canSelectFolders: false, filters: [{ name: localize('sessions.design.images', 'Images'), extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
			if (!resources || this.isDisposed) { return undefined; }
			const read = await this.files.readFileBytes(resources[0]);
			const metadata = await this.assets.importImage({ assetId: generateUuid(), versionId: generateUuid(), name: basename(read.resource), source: read.resource, bytes: read.bytes });
			return await this.placeImage(metadata, center, versionToken);
		} catch (error) {
			await this.dialogs.error(localize('sessions.design.importFailed', 'Could not import the image.'), String(error));
			return undefined;
		} finally {
			this.isFileOperationRunning = false;
			if (!this.isDisposed) { this.changeEmitter.fire({}); }
		}
	}
	public async adoptAssetVersion(metadata: AssetVersion, center: DesignPoint): Promise<string | undefined> {
		if (this.isBusy) { return undefined; }
		this.isFileOperationRunning = true;
		this.changeEmitter.fire({});
		try { return await this.placeImage(metadata, center, this.model.version); }
		catch (error) { await this.dialogs.error(localize('sessions.design.importFailed', 'Could not import the image.'), String(error)); return undefined; }
		finally { this.isFileOperationRunning = false; if (!this.isDisposed) { this.changeEmitter.fire({}); } }
	}

	private async placeImage(metadata: AssetVersion, center: DesignPoint, versionToken: string): Promise<string | undefined> {
		const bytes = await this.assets.readVersion(metadata);
		const sha256 = metadata.sha256;
		if (this.isDisposed) { return undefined; }
		if (this.model.version !== versionToken) { throw new Error(localize('sessions.design.importChanged', 'The design changed while the image was importing. Import it again at the current location.')); }
		const version: DesignAssetVersion = { mediaType: metadata.mediaType, width: metadata.width, height: metadata.height, id: metadata.versionId, sha256, path: `assets/${sha256}` };
		const existing = this.model.value.assets.find(asset => asset.id === metadata.assetId);
		const versions = existing ? [...existing.versions] : [];
		if (!versions.some(saved => saved.id === version.id)) { versions.push(version); }
		const asset = { id: metadata.assetId, name: metadata.name, versions };
		const scale = Math.min(1, 480 / Math.max(metadata.width, metadata.height));
		const width = metadata.width * scale;
		const height = metadata.height * scale;
		const id = generateUuid();
		this.media.set(sha256, bytes);
		new DocumentCommands(this.model).insertShape({ id, kind: 'image', assetId: asset.id, assetVersionId: version.id, crop: { x: 0, y: 0, width: 1, height: 1 }, x: center.x - width / 2, y: center.y - height / 2, width, height, rotation: 0, fill: '#ffffff' }, [...this.model.value.assets.filter(saved => saved.id !== asset.id), asset]);
		this.changeEmitter.fire({ message: localize('sessions.design.imageImported', 'Imported {0}', asset.name) });
		return id;
	}

	public async save(signal: AbortSignal): Promise<void> { signal.throwIfAborted(); await this.saveDocument(); }
	public async saveAs(resource: URI, signal: AbortSignal): Promise<void> { signal.throwIfAborted(); await this.saveDocument(resource); }
	public async revert(signal: AbortSignal): Promise<void> { signal.throwIfAborted(); this.model.replace(parseDesignDocument(this.savedContent)); }

	public async exportDocument(output?: { title: string; filename: string; extension: string; content: string; }): Promise<void> {
		if (this.isFileOperationRunning) { return; }
		this.isFileOperationRunning = true;
		this.changeEmitter.fire({});
		try {
			if (!output) { if (flattenDesignShapes(this.model.value.shapes).some(shape => shape.kind === 'group' && shape.booleanOperation)) { await loadDesignVectorGeometry(); } output = { title: localize('sessions.design.export', 'Export SVG'), filename: `${this.mode}.svg`, extension: 'svg', content: exportDesignSvg(this.model.value, this.getEmbeddedImageSources()) }; }
			const resource = await this.fileDialogs.showSaveDialog({ title: output.title, defaultUri: this.workspace.getWorkspace().folders[0]?.uri.joinPathSegment(output.filename), filters: [{ name: output.extension.toUpperCase(), extensions: [output.extension] }] });
			if (!resource || this.isDisposed) { return; }
			await this.files.writeFile({ resource, content: output.content });
			if (!this.isDisposed) { this.changeEmitter.fire({ message: localize('sessions.design.exported', 'Exported {0}', basename(resource)) }); }
		} catch (error) {
			await this.dialogs.error(localize('sessions.design.exportFailed', 'Could not export the design.'), String(error));
		} finally {
			this.isFileOperationRunning = false;
			if (!this.isDisposed) { this.changeEmitter.fire({}); }
		}
	}

	/** Returns a shutdown/open veto, including a cancelled or failed save. */
	public async confirmDiscard(): Promise<boolean> {
		if (this.isFileOperationRunning) { return true; }
		if (!this.isDirty) { return false; }
		this.isFileOperationRunning = true;
		this.changeEmitter.fire({});
		let result: ConfirmResult;
		try {
			result = await this.fileDialogs.showSaveConfirm([this.name]);
		} finally {
			this.isFileOperationRunning = false;
			if (!this.isDisposed) { this.changeEmitter.fire({}); }
		}
		if (result === ConfirmResult.CANCEL) { return true; }
		if (result === ConfirmResult.SAVE) { return !(await this.saveDocument()); }
		return false;
	}

	public async openDocument(): Promise<void> {
		if (await this.confirmDiscard()) { return; }
		this.isFileOperationRunning = true;
		this.changeEmitter.fire({});
		try {
			const resources = await this.fileDialogs.showOpenDialog({ title: this.mode === CreatorMode.Design ? localize('sessions.design.open', 'Open design') : localize('sessions.creator.open', 'Open document'), defaultUri: this.file ? dirname(this.file.resource) : undefined, canSelectFiles: true, canSelectFolders: true, filters: [{ name: localize('sessions.design.fileType', 'Ash design'), extensions: ['ash-design', 'json'] }] });
			if (!resources || this.isDisposed) { return; }
			const selected = resources[0];
			const isPackage = (await this.files.stat(selected)).kind === FileKind.Directory;
			const read = await this.files.readFile(isPackage ? selected.joinPathSegment('manifest.json') : selected);
			const document = parseDesignDocument(read.content);
			if (document.mode !== this.mode) { throw new TypeError(localize('sessions.creator.wrongMode', 'This document belongs to {0}. Open it in that Creator mode.', getCreatorModeTitle(document.mode))); }
			const root = isPackage ? selected : dirname(selected);
			const media = new Map<string, Uint8Array>();
			for (const asset of document.assets) {
				for (const version of asset.versions) {
					const data = await this.files.readFileBytes(URI.joinPath(root, version.path));
					if (await hashDesignMedia(data.bytes) !== version.sha256) { throw new Error(localize('sessions.design.mediaCorrupt', 'Image content does not match its saved version: {0}', asset.name)); }
					media.set(version.sha256, data.bytes);
				}
			}
			if (this.isDisposed) { return; }
			this.file = isPackage || basename(selected) === 'manifest.json' ? { resource: root, revision: read.revision } : undefined;
			this.media = media;
			this.setExternalChange(false);
			this.labelChange.fire();
			this.model.replace(document);
			this.savedContent = serializeDesignDocument(this.model.value);
			this.changeEmitter.fire({ message: localize('sessions.design.opened', 'Opened {0}', basename(isPackage ? selected : read.resource)) });
		} catch (error) {
			await this.dialogs.error(localize('sessions.design.openFailed', 'Could not open the design.'), String(error));
		} finally {
			this.isFileOperationRunning = false;
			if (!this.isDisposed) { this.changeEmitter.fire({}); }
		}
	}

	public async saveDocument(target?: URI): Promise<boolean> {
		if (this.isFileOperationRunning) { return false; }
		this.isFileOperationRunning = true;
		this.changeEmitter.fire({});
		try {
			const resource = target ?? this.file?.resource ?? await this.fileDialogs.showSaveDialog({ title: this.mode === CreatorMode.Design ? localize('sessions.design.save', 'Save design') : localize('sessions.creator.save', 'Save document'), defaultUri: this.workspace.getWorkspace().folders[0]?.uri.joinPathSegment(`${this.mode}.ash-design`), filters: [{ name: localize('sessions.design.fileType', 'Ash design'), extensions: ['ash-design'] }] });
			if (!resource || this.isDisposed) { return false; }
			const isCopy = !!this.file && !extUri.isEqual(this.file.resource, resource);
			const snapshot = isCopy ? documentFromShapes(this.model.value.shapes, { ...this.model.value, documentId: generateUuid() }, this.model.value.assets) : this.model.value;
			const content = serializeDesignDocument(snapshot);
			await this.files.createDirectory(resource);
			await this.files.createDirectory(resource.joinPathSegment('assets'));
			for (const asset of snapshot.assets) {
				for (const version of asset.versions) {
					const bytes = this.readMedia(version);
					if (await hashDesignMedia(bytes) !== version.sha256) { throw new Error(localize('sessions.design.mediaCorrupt', 'Image content does not match its saved version: {0}', asset.name)); }
					const target = URI.joinPath(resource, version.path);
					let exists = false;
					try { await this.files.stat(target); exists = true; }
					catch (error) { if (!(error instanceof FileNotFoundError)) { throw error; } }
					if (exists) {
						if (await hashDesignMedia((await this.files.readFileBytes(target)).bytes) !== version.sha256) { throw new Error(localize('sessions.design.mediaCorrupt', 'Image content does not match its saved version: {0}', asset.name)); }
					} else { await this.files.writeFileBytes(target, bytes); }
				}
			}
			const manifest = resource.joinPathSegment('manifest.json');
			let expectedRevision = this.file && extUri.isEqual(this.file.resource, resource) ? this.file.revision : undefined;
			if (expectedRevision === undefined) {
				try { expectedRevision = (await this.files.readFile(manifest)).revision; }
				catch (error) { if (!(error instanceof FileNotFoundError)) { throw error; } }
			}
			const result = await this.files.writeFile({ resource: manifest, content, expectedRevision });
			if (this.isDisposed) { return false; }
			this.file = { resource, revision: result.revision };
			this.labelChange.fire();
			this.savedContent = content;
			this.setExternalChange(false);
			if (isCopy) { this.model.changeIdentity(snapshot.documentId); }
			this.changeEmitter.fire({ message: localize('sessions.design.saved', 'Saved {0}', basename(resource)) });
			return !this.isDirty;
		} catch (error) {
			await this.dialogs.error(localize('sessions.design.saveFailed', 'Could not save the design. Your changes are still in the canvas.'), String(error));
			return false;
		} finally {
			this.isFileOperationRunning = false;
			if (!this.isDisposed) { this.changeEmitter.fire({}); }
		}
	}

	/** Publish a portable, immutable version through the same local/remote workspace file service. */
	public async publishLibrary(): Promise<void> {
		await this.libraryOperation(async () => {
			const source = this.model.value;
			const resource = this.publication?.documentId === source.documentId ? this.publication.resource : await this.fileDialogs.showSaveDialog({ title: localize('sessions.design.publishLibrary', 'Publish library'), defaultUri: this.workspace.getWorkspace().folders[0]?.uri.joinPathSegment('library.ash-design-library'), filters: [{ name: localize('sessions.design.designLibrary', 'Design library'), extensions: ['ash-design-library'] }] });
			if (!resource || this.isDisposed) { return; }
			const resources = source.resources ?? emptyDesignResources;
			const reusable = (shapes: readonly DesignShape[]): readonly DesignShape[] => shapes.flatMap(shape => shape.kind === 'frame' && shape.component ? [shape] : shape.kind === 'frame' || shape.kind === 'group' ? reusable(shape.children) : []);
			const shapes = reusable([...source.shapes, ...getDesignLibraryShapes(resources)]);
			const images = flattenDesignShapes(shapes).filter(shape => shape.kind === 'image');
			const assets = source.assets.flatMap(asset => { const versions = asset.versions.filter(version => images.some(shape => shape.assetId === asset.id && shape.assetVersionId === version.id)); return versions.length ? [{ ...asset, versions }] : []; });
			const document = documentFromShapes(shapes, { ...source, resources: { ...getDesignResourceCatalog(resources), libraries: [], modes: resources.modes } }, assets);
			const media: Record<string, string> = {};
			for (const asset of document.assets) {
				for (const version of asset.versions) {
					const bytes = this.readMedia(version);
					if (await hashDesignMedia(bytes) !== version.sha256) { throw new Error(localize('sessions.design.mediaCorrupt', 'Image content does not match its saved version: {0}', asset.name)); }
					media[version.sha256] = encodeDesignMedia(bytes);
				}
			}
			let expectedRevision: string | undefined;
			try {
				const current = await this.files.readFile(resource);
				const old: unknown = JSON.parse(current.content);
				if (!isRecord(old) || old.kind !== 'ash-design-library' || !isRecord(old.document) || old.document.documentId !== source.documentId) { throw new Error(localize('sessions.design.libraryConflict', 'This library contains conflicting resource identities.')); }
				expectedRevision = current.revision;
			} catch (error) { if (!(error instanceof FileNotFoundError)) { throw error; } }
			const name = basename(resource).replace(/\.ash-design-library$/u, '');
			await this.files.writeFile({ resource, expectedRevision, content: JSON.stringify({ kind: 'ash-design-library', name, document: JSON.parse(serializeDesignDocument(document)), media }) });
			if (!this.isDisposed) { this.publication = { documentId: source.documentId, resource }; this.changeEmitter.fire({ message: localize('sessions.design.libraryPublished', 'Published {0}. Other files can review and accept this version.', name) }); }
		});
	}
	public async addLibrary(): Promise<void> {
		await this.libraryOperation(async () => {
			const token = this.model.version;
			const paths = await this.fileDialogs.showOpenDialog({ title: localize('sessions.design.addLibrary', 'Add library'), canSelectFiles: true, canSelectFolders: false, filters: [{ name: localize('sessions.design.designLibrary', 'Design library'), extensions: ['ash-design-library'] }] });
			if (!paths || this.isDisposed) { return; }
			const loaded = await this.readLibrary(paths[0]);
			if (this.isDisposed || token !== this.model.version) { return; }
			const current = this.model.value.resources?.libraries.find(library => library.id === loaded.library.id);
			if (current) {
				if (current.version !== loaded.library.version) { this.libraryUpdates.set(current.id, { ...loaded, baseVersion: current.version }); }
				else { new DocumentCommands(this.model).resources.setLibraryEnabled(current.id, true); }
			} else {
				this.applyLibrary(loaded.library, loaded.media);
			}
		});
	}
	public async checkLibraryUpdate(id: string): Promise<void> {
		await this.libraryOperation(async () => {
			const current = this.model.value.resources?.libraries.find(library => library.id === id); if (!current) { return; }
			const token = this.model.version;
			const loaded = await this.readLibrary(URI.parse(current.uri));
			if (this.isDisposed || token !== this.model.version) { return; }
			if (loaded.library.id !== id) { throw new TypeError(localize('sessions.design.libraryConflict', 'This library contains conflicting resource identities.')); }
			if (loaded.library.version !== current.version) { this.libraryUpdates.set(id, { ...loaded, baseVersion: current.version }); }
			else { this.libraryUpdates.delete(id); this.changeEmitter.fire({ message: localize('sessions.design.libraryCurrent', '{0} is up to date.', current.name) }); }
		});
	}
	public acceptLibraryUpdate(id: string): void {
		const update = this.libraryUpdates.get(id); const library = this.getLibraryUpdate(id);
		if (this.isBusy || !update || !library) { return; }
		try {
			const current = this.model.value.resources!.libraries.find(library => library.id === id)!;
			this.applyLibrary({ ...library, enabled: current.enabled }, update.media);
			this.libraryUpdates.delete(id);
			this.changeEmitter.fire({ message: localize('sessions.design.libraryUpdated', 'Updated {0}. Instance overrides were retained.', library.name) });
		} catch (error) { void this.dialogs.error(localize('sessions.design.libraryFailed', 'Could not update the design library.'), String(error)); }
	}
	private applyLibrary(library: DesignLibrary, media: ReadonlyMap<string, Uint8Array>): void {
		// The synchronous model event needs media ready for rendering. Roll back
		// additions if graph validation rejects the candidate before committing it.
		const added: string[] = [];
		for (const [hash, bytes] of media) { if (!this.media.has(hash)) { this.media.set(hash, bytes); added.push(hash); } }
		try { new DocumentCommands(this.model).resources.acceptLibrary(library); }
		catch (error) { for (const hash of added) { this.media.delete(hash); } throw error; }
	}

	private async libraryOperation(run: () => Promise<void>): Promise<void> {
		if (this.isBusy) { return; }
		this.isFileOperationRunning = true; this.changeEmitter.fire({});
		try { await run(); }
		catch (error) { await this.dialogs.error(localize('sessions.design.libraryFailed', 'Could not update the design library.'), String(error)); }
		finally { this.isFileOperationRunning = false; if (!this.isDisposed) { this.changeEmitter.fire({}); } }
	}
	private async readLibrary(resource: URI): Promise<{ readonly library: DesignLibrary; readonly media: ReadonlyMap<string, Uint8Array>; }> {
		const read = await this.files.readFile(resource);
		const value: unknown = JSON.parse(read.content);
		if (!isRecord(value) || value.kind !== 'ash-design-library' || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 256 || !isRecord(value.media) || Object.keys(value).some(key => !['kind', 'name', 'document', 'media'].includes(key))) { throw new TypeError(localize('sessions.design.invalidResources', 'Invalid design resource, binding, or circular variable alias.')); }
		const document = parseDesignDocument(JSON.stringify(value.document));
		if (document.resources?.libraries.length) { throw new TypeError(localize('sessions.design.libraryConflict', 'This library contains conflicting resource identities.')); }
		const media = new Map<string, Uint8Array>();
		for (const asset of document.assets) {
			for (const version of asset.versions) {
				const encoded = value.media[version.sha256];
				if (typeof encoded !== 'string' || !encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) { throw new TypeError(localize('sessions.design.backupMediaMissing', 'Missing design backup media')); }
				const bytes = decodeBase64(encoded).buffer;
				if (await hashDesignMedia(bytes) !== version.sha256) { throw new Error(localize('sessions.design.mediaCorrupt', 'Image content does not match its saved version: {0}', asset.name)); }
				media.set(version.sha256, bytes);
			}
		}
		return { library: { id: document.documentId, name: value.name, uri: resource.toString(), version: await hashDesignMedia(new TextEncoder().encode(read.content)), enabled: true, document }, media };
	}

	private setExternalChange(value: boolean): void {
		if (this.externalChange !== value) { this.externalChange = value; this.externalChangeEmitter.fire(); }
	}

	private async checkExternalChange(): Promise<void> {
		const file = this.file;
		if (!file || this.isBusy || this.isDisposed) { return; }
		try {
			const read = await this.files.readFile(file.resource.joinPathSegment('manifest.json'));
			if (this.file === file && !this.isDisposed) { this.setExternalChange(read.revision !== file.revision); }
		} catch (error) {
			if (error instanceof FileNotFoundError && this.file === file && !this.isDisposed) { this.setExternalChange(true); }
			else if (!this.isDisposed) { await this.dialogs.error(localize('sessions.design.checkFileFailed', 'Could not check the saved design for external changes.'), String(error)); }
		}
	}
}
