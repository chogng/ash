import { CodeEditorWidget, type CodeEditorWidgetOptions } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { createEditorBrowserServices } from '../../../../editor/browser/services/contribution.js';
import type { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

export const editorBrowserServices = createEditorBrowserServices();

/** Creates a browser editor for a model whose language state is already model-owned. */
export function createBrowserEditorPart(instantiationService: IInstantiationService, options: CodeEditorWidgetOptions): CodeEditorWidget {
	const editorWorkers = editorBrowserServices.workers;
	return instantiationService.createInstance(CodeEditorWidget, {
		...options,
		codeEditorService: editorBrowserServices.codeEditorService,
		editorWorkerFactory: editorWorkers.editorWorkerFactory,
	});
}
