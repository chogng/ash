import { isRemoteResource } from '../../../../../platform/remote/common/remote.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { TextResourceEditor, type EditorPaneOptions } from '../../../../browser/parts/editor/textResourceEditor.js';
import { type EditorInput } from '../../../../services/editor/common/editorService.js';
import { ITextModelResourceService } from '../../../../services/textmodelResolver/common/textModelResourceService.js';
import { type ITextResourceStore } from '../../../../services/textmodelResolver/common/textResourceStore.js';
import { TextFileSaveErrorHandler } from './textFileSaveErrorHandler.js';

/** File-backed text pane; text model loading, saving, and dirty state share Workbench ownership. */
export class TextFileEditor extends TextResourceEditor {
	private readonly saveErrorHandler: TextFileSaveErrorHandler;

	constructor(
		resourceStore: ITextResourceStore,
		options: EditorPaneOptions,
		@ITextModelResourceService modelService: ITextModelResourceService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IDialogService dialogs: IDialogService,
	) {
		super(resourceStore, options, modelService, instantiationService, configurationService);
		this.saveErrorHandler = new TextFileSaveErrorHandler(dialogs);
	}

	override async setInput(input: EditorInput, signal: AbortSignal): Promise<void> {
		if (input.resource.scheme !== 'file' && !isRemoteResource(input.resource)) {
			throw new TypeError('Text file editor requires a file resource');
		}
		await super.setInput(input, signal);
	}

	protected override handleSaveError(error: unknown): Promise<void> {
		return this.saveErrorHandler.onSaveError(error, this.workingCopy?.resource);
	}
}
