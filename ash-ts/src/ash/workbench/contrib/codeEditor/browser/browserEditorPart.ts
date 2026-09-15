import { CodeEditorWidget, type CodeEditorWidgetOptions } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { createEditorBrowserServices } from '../../../../editor/browser/services/contribution.js';
import type { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import type { ILanguageConfigurationService } from '../../../../editor/common/languages/languageConfigurationRegistry.js';

export type BrowserEditorPartOptions = CodeEditorWidgetOptions & {
	readonly instantiationService: IInstantiationService;
	readonly languageFeaturesService: ILanguageFeaturesService;
	readonly languageConfigurationService: ILanguageConfigurationService;
};

export const editorBrowserServices = createEditorBrowserServices();

/** Creates a browser editor for a model whose language state is already model-owned. */
export function createBrowserEditorPart(options: BrowserEditorPartOptions): CodeEditorWidget {
	const editorWorkers = editorBrowserServices.workers;
	return new CodeEditorWidget({
		...options,
		codeEditorService: editorBrowserServices.codeEditorService,
		editorWorkerFactory: editorWorkers.editorWorkerFactory,
	});
}
