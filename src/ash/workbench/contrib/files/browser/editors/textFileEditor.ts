import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput, ISaveOptions } from '../../../../common/editor.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { isRemoteResource } from '../../../../../platform/remote/common/remote.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { TextResourceEditor, type EditorPaneOptions } from '../../../../browser/parts/editor/textResourceEditor.js';
import { ITextModelResourceService } from '../../../../services/textmodelResolver/common/textModelResourceService.js';
import { type ITextResourceStore } from '../../../../services/textmodelResolver/common/textResourceStore.js';
import { TextFileSaveErrorHandler } from './textFileSaveErrorHandler.js';
import { IFilesConfigurationService } from '../../../../services/filesConfiguration/common/filesConfigurationService.js';
import { localize } from '../../../../../nls.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';

/** File-backed text pane; text model loading, saving, and dirty state share Workbench ownership. */
export class TextFileEditor extends TextResourceEditor {
	private readonly saveErrorHandler: TextFileSaveErrorHandler;
	private fileInput: IResourceEditorInput | undefined;
	private readonly retryCancellation = this._register(new MutableDisposable());

	constructor(
		resourceStore: ITextResourceStore,
		options: EditorPaneOptions,
		@ITextModelResourceService modelService: ITextModelResourceService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@ITextModelService textModelService: ITextModelService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFilesConfigurationService private readonly filesConfiguration: IFilesConfigurationService,
		@IFileDialogService private readonly fileDialogs: IFileDialogService,
	) {
		super(resourceStore, options, modelService, instantiationService, configurationService, textModelService, themeService, storageService);
		this.saveErrorHandler = instantiationService.createInstance(TextFileSaveErrorHandler);
		this._register(filesConfiguration.onDidChangeReadonly(() => {
			if (this.fileInput) this.getControl()?.updateOptions({ readOnly: this.fileInput.readOnly || !!filesConfiguration.isReadonly(this.fileInput.resource) });
		}));
	}

	override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		this.retryCancellation.clear();
		if (input.resource.scheme !== 'file' && !isRemoteResource(input.resource)) {
			throw new TypeError('Text file editor requires a file resource');
		}
		await super.setInput(input, signal);
		this.fileInput = input;
		this.getControl()?.updateOptions({ readOnly: input.readOnly || !!this.filesConfiguration.isReadonly(input.resource) });
	}

	public override async save(options?: ISaveOptions): Promise<void> {
		if (this.fileInput && this.filesConfiguration.isReadonly(this.fileInput.resource)) {
			const error = new Error(localize('files.configuredReadonly', 'This file is read-only because it matches the configured read-only patterns.'));
			await this.handleSaveError(error);
			throw error;
		}
		await super.save(options);
	}

	public override clearInput(): void {
		this.retryCancellation.clear();
		this.fileInput = undefined;
		super.clearInput();
	}

	protected override handleSaveError(error: unknown): Promise<boolean> {
		const workingCopy = this.workingCopy;
		return this.saveErrorHandler.onSaveError(error, workingCopy?.resource, workingCopy ? async options => {
			if (this.workingCopy !== workingCopy) { throw new Error(localize('files.saveEditorClosed', 'The editor was closed before the save retry.')); }
			const controller = new AbortController();
			const cancellation = toDisposable(() => controller.abort());
			this.retryCancellation.value = cancellation;
			try { await workingCopy.save(controller.signal, options); }
			finally { if (this.retryCancellation.value === cancellation) { this.retryCancellation.clear(); } }
		} : undefined, workingCopy ? {
			saveAs: async () => {
				const target = await this.fileDialogs.pickFileToSave(workingCopy.resource);
				if (!target || this.workingCopy !== workingCopy) { return false; }
				await this.saveAs(target);
				return true;
			},
			revert: async () => { if (this.workingCopy === workingCopy) { await workingCopy.revert(new AbortController().signal); } },
		} : undefined);
	}
}
