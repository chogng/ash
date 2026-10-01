import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ConfirmResult, IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { parseDesignDocument, serializeDesignDocument } from '../common/model/document.js';
import { DesignModel } from '../common/model/designModel.js';
import { exportDesignSvg } from './svgRenderer.js';
import type { IWorkingCopy } from '../../../../workbench/services/workingCopy/common/workingCopyService.js';

/** The canvas keeps one editor identity while Open design replaces its file and document. */
export const DESIGN_EDITOR_RESOURCE = URI.parse('ash-design:/canvas');

/** Owns file identity, read revision and saved content for a design document. */
export class DesignDocumentController extends Disposable implements IWorkingCopy {
	public readonly resource = DESIGN_EDITOR_RESOURCE;
	public readonly backupKind = 'structuredDocument' as const;
	public readonly backupContentType = 'application/vnd.ash.design+json';
	public readonly hasExternalChange = false;
	public readonly onDidChangeExternalChange = Event.None;
	public readonly model = this._register(new DesignModel());
	private readonly changeEmitter = this._register(new Emitter<{ readonly message?: string }>());
	public readonly onDidChange = this.changeEmitter.event;
	private readonly labelChange = this._register(new Emitter<void>());
	public readonly onDidChangeLabel = this.labelChange.event;
	private readonly dirtyChange = this._register(new Emitter<void>());
	private readonly contentChange = this._register(new Emitter<void>());
	public readonly onDidChangeContent = this.contentChange.event;
	public readonly onDidChangeDirty = this.dirtyChange.event;
	private file: { resource: URI; revision: string } | undefined;
	private savedContent = serializeDesignDocument(this.model.value);
	private isFileOperationRunning = false;

	constructor(
		@IFileService private readonly files: IFileService,
		@IFileDialogService private readonly fileDialogs: IFileDialogService,
		@IDialogService private readonly dialogs: IDialogService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) {
		super();
		this._register(this.model.onDidChange(() => { this.contentChange.fire(); this.dirtyChange.fire(); }));
		this._register(this.onDidChange(() => this.dirtyChange.fire()));
	}

	public get name(): string { return this.file ? basename(this.file.resource) : localize('sessions.design.untitled', 'Untitled design'); }
	public get isBusy(): boolean { return this.isFileOperationRunning; }
	public get isDirty(): boolean { return serializeDesignDocument(this.model.value) !== this.savedContent; }
	public backup(): string { return serializeDesignDocument(this.model.value); }
	public restoreBackup(content: string): void { this.model.replace(parseDesignDocument(content)); }
	public async save(signal: AbortSignal): Promise<void> { signal.throwIfAborted(); await this.saveDocument(); }
	public async saveAs(resource: URI, signal: AbortSignal): Promise<void> { signal.throwIfAborted(); await this.saveDocument(resource); }
	public async revert(signal: AbortSignal): Promise<void> { signal.throwIfAborted(); this.model.replace(parseDesignDocument(this.savedContent)); }

	public async exportDocument(output = { title: localize('sessions.design.export', 'Export SVG'), filename: 'design.svg', extension: 'svg', content: exportDesignSvg(this.model.value) }): Promise<void> {
		if (this.isFileOperationRunning) { return; }
		this.isFileOperationRunning = true;
		this.changeEmitter.fire({});
		try {
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
			const resources = await this.fileDialogs.showOpenDialog({ title: localize('sessions.design.open', 'Open design'), defaultUri: this.file?.resource, canSelectFiles: true, canSelectFolders: false, filters: [{ name: localize('sessions.design.fileType', 'Ash design'), extensions: ['json'] }] });
			if (!resources || this.isDisposed) { return; }
			const read = await this.files.readFile(resources[0]);
			const document = parseDesignDocument(read.content);
			if (this.isDisposed) { return; }
			this.file = { resource: read.resource, revision: read.revision };
			this.labelChange.fire();
			this.savedContent = serializeDesignDocument(document);
			this.model.replace(document);
			this.changeEmitter.fire({ message: localize('sessions.design.opened', 'Opened {0}', basename(read.resource)) });
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
			const resource = target ?? this.file?.resource ?? await this.fileDialogs.showSaveDialog({ title: localize('sessions.design.save', 'Save design'), defaultUri: this.workspace.getWorkspace().folders[0]?.uri.joinPathSegment('design.ash-design.json'), filters: [{ name: localize('sessions.design.fileType', 'Ash design'), extensions: ['json'] }] });
			if (!resource || this.isDisposed) { return false; }
			const content = serializeDesignDocument(this.model.value);
			const result = await this.files.writeFile({ resource, content, expectedRevision: this.file?.resource.toString() === resource.toString() ? this.file.revision : undefined });
			if (this.isDisposed) { return false; }
			this.file = { resource, revision: result.revision };
			this.labelChange.fire();
			this.savedContent = content;
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
}
