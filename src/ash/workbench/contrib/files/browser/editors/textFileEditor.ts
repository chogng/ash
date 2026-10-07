import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { isRemoteResource } from '../../../../../platform/remote/common/remote.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { TextResourceEditor, type EditorPaneOptions } from '../../../../browser/parts/editor/textResourceEditor.js';
import { ITextModelResourceService } from '../../../../services/textmodelResolver/common/textModelResourceService.js';
import { type ITextResourceStore } from '../../../../services/textmodelResolver/common/textResourceStore.js';
import { TextFileSaveErrorHandler } from './textFileSaveErrorHandler.js';
import { IFilesConfigurationService } from '../../../../services/filesConfiguration/common/filesConfigurationService.js';
import { localize } from '../../../../../nls.js';

/** File-backed text pane; text model loading, saving, and dirty state share Workbench ownership. */
export class TextFileEditor extends TextResourceEditor {
	private readonly saveErrorHandler: TextFileSaveErrorHandler;
	private fileInput: IResourceEditorInput | undefined;

	constructor(
		resourceStore: ITextResourceStore,
		options: EditorPaneOptions,
		@ITextModelResourceService modelService: ITextModelResourceService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IDialogService dialogs: IDialogService,
		@ITextModelService textModelService: ITextModelService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFilesConfigurationService private readonly filesConfiguration: IFilesConfigurationService,
	) {
		super(resourceStore, options, modelService, instantiationService, configurationService, textModelService, themeService, storageService);
		this.saveErrorHandler = new TextFileSaveErrorHandler(dialogs);
		this._register(filesConfiguration.onDidChangeReadonly(() => {
			if (this.fileInput) this.getControl()?.updateOptions({ readOnly: this.fileInput.readOnly || !!filesConfiguration.isReadonly(this.fileInput.resource) });
		}));
	}

	override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		if (input.resource.scheme !== 'file' && !isRemoteResource(input.resource)) {
			throw new TypeError('Text file editor requires a file resource');
		}
		await super.setInput(input, signal);
		this.fileInput = input;
		this.getControl()?.updateOptions({ readOnly: input.readOnly || !!this.filesConfiguration.isReadonly(input.resource) });
	}

	public override async save(): Promise<void> {
		if (this.fileInput && this.filesConfiguration.isReadonly(this.fileInput.resource)) {
			const error = new Error(localize('files.configuredReadonly', 'This file is read-only because it matches the configured read-only patterns.'));
			await this.handleSaveError(error);
			throw error;
		}
		await super.save();
	}

	public override clearInput(): void {
		this.fileInput = undefined;
		super.clearInput();
	}

	protected override handleSaveError(error: unknown): Promise<void> {
		return this.saveErrorHandler.onSaveError(error, this.workingCopy?.resource);
	}
}
