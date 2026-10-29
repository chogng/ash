import { IWebWorkerService } from '../../../../platform/webWorker/browser/webWorkerService.js';
import { type TextModel } from '../../../../editor/common/model/textModel.js';
import { CodeEditorWidget, type CodeEditorWidgetOptions } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { createEditorWorkerClient } from '../../../../editor/browser/services/editorWorkerService.js';
import type { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

/** Creates a browser editor for a model whose language state is already model-owned. */
export function createBrowserEditorPart(instantiationService: IInstantiationService, options: CodeEditorWidgetOptions): CodeEditorWidget {
	const workers = instantiationService.invokeFunction(accessor => accessor.get(IWebWorkerService));
	return instantiationService.createInstance(CodeEditorWidget, {
		...options,
		editorWorkerFactory: (model: TextModel) => createEditorWorkerClient(model, workers),
	});
}
