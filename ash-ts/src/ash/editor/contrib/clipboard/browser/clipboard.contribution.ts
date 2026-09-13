import { Disposable } from '../../../../base/common/lifecycle.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IInstantiationService, ServiceConstructionDescriptor } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorContributionInstantiation, registerTextEditorCapabilityContribution, type TextEditorContributionContext } from '../../../browser/editorExtensions.js';
import { TextEditorCapability } from '../../textEditorCapabilities.js';
import { ClipboardController } from './clipboardController.js';

class ClipboardContribution extends Disposable {
	public constructor(context: TextEditorContributionContext, instantiationService: IInstantiationService) {
		super();
		const clipboardService = instantiationService.get(IClipboardService);
		this._register(new ClipboardController(context.view.editContext, context.viewport, context.selectionController, context.view, clipboardService, {
			semanticTokens: context.getOptionalCapability(TextEditorCapability.semanticTokenSource),
			isEditingAllowed: () => !context.view.compositionController.composing,
		}));
	}
}

registerTextEditorCapabilityContribution({
	id: 'editor.contrib.clipboard',
	runtime: {
		descriptor: new ServiceConstructionDescriptor(ClipboardContribution, { serviceDependencies: [IInstantiationService] }),
		instantiation: EditorContributionInstantiation.Eager,
	},
});
