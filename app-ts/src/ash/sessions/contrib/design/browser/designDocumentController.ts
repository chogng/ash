import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ConfirmResult, IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { parseDesignDocument, serializeDesignDocument } from '../common/model/document.js';
import { DesignModel } from '../common/model/designModel.js';
import { exportDesignSvg } from './svgRenderer.js';

/** Owns file identity, read revision and saved content for a design document. */
export class DesignDocumentController extends Disposable {
	public readonly model = this._register(new DesignModel());
	private readonly changeEmitter = this._register(new Emitter<{ readonly message?: string }>());
	public readonly onDidChange = this.changeEmitter.event;
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
	}

	public get isBusy(): boolean { return this.isFileOperationRunning; }
	public get isDirty(): boolean { return serializeDesignDocument(this.model.value) !== this.savedContent; }

	public async exportDocument(): Promise<void> {
		if (this.isFileOperationRunning) { return; }
		this.isFileOperationRunning = true;
		this.changeEmitter.fire({});
		try {
			const resource = await this.fileDialogs.showSaveDialog({ title: localize('sessions.design.export', 'Export SVG'), defaultUri: this.workspace.getWorkspace().folders[0]?.uri.joinPathSegment('design.svg'), filters: [{ name: 'SVG', extensions: ['svg'] }] });
			if (!resource || this.isDisposed) { return; }
			await this.files.writeFile({ resource, content: exportDesignSvg(this.model.value) });
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
			result = await this.fileDialogs.showSaveConfirm([this.file ? basename(this.file.resource) : localize('sessions.design.untitled', 'Untitled design')]);
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

	public async saveDocument(): Promise<boolean> {
		if (this.isFileOperationRunning) { return false; }
		this.isFileOperationRunning = true;
		this.changeEmitter.fire({});
		try {
			const resource = this.file?.resource ?? await this.fileDialogs.showSaveDialog({ title: localize('sessions.design.save', 'Save design'), defaultUri: this.workspace.getWorkspace().folders[0]?.uri.joinPathSegment('design.ash-design.json'), filters: [{ name: localize('sessions.design.fileType', 'Ash design'), extensions: ['json'] }] });
			if (!resource || this.isDisposed) { return false; }
			const content = serializeDesignDocument(this.model.value);
			const result = await this.files.writeFile({ resource, content, expectedRevision: this.file?.revision });
			if (this.isDisposed) { return false; }
			this.file = { resource, revision: result.revision };
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
