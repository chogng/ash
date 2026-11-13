import type { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { ScreenshotToolService } from '../../../src/ash/workbench/contrib/screenshotTool/browser/screenshotToolService.js';
import { readCodeImageSelection } from '../../../src/ash/workbench/services/imageEditor/browser/imageEditorSelection.js';
import { IScreenshotToolService } from '../../../src/ash/workbench/contrib/screenshotTool/browser/screenshotTool.js';
import { IImageEditorService } from '../../../src/ash/workbench/services/imageEditor/common/imageEditorService.js';
import { ICodeEditorService } from '../../../src/ash/editor/browser/services/codeEditorService.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { EditorSemanticHighlightingConfiguration } from '../../../src/ash/editor/common/config/editorConfigurationSchema.js';
import '../../../src/ash/workbench/contrib/screenshotTool/browser/screenshotToolConfiguration.js';

/** The production screenshot service; the fixture owns retirement so it can test cancellation. */
export async function startImageEditorFixture(services: InstantiationService, resources: DisposableStore): Promise<{ stop(): Promise<void>; runCode(): Promise<void>; }> {
	// Extension defaults must not intercept the product's screenshot workflow.
	const images = services.get(IImageEditorService);
	for (const id of ['test.first-default', 'test.second-default']) {
		resources.add(images.register({
			id, displayName: id, default: true, accessibilityHelp: '', signal: new AbortController().signal,
			resolve: async () => { throw new Error('The built-in screenshot must not resolve an extension provider'); },
		}));
	}
	const screenshots = services.get(IScreenshotToolService);
	if (!(screenshots instanceof ScreenshotToolService)) throw new Error('The screenshot fixture requires the production service');
	const codeEditors = services.get(ICodeEditorService);
	const theme = services.get(IThemeService);
	const configuration = services.get(IConfigurationService);
	return {
		async stop() { screenshots.dispose(); },
		async runCode() {
			const signal = new AbortController().signal;
			const code = await readCodeImageSelection(codeEditors.getActiveCodeEditor(), theme.getColorTheme(), configuration.getValue<boolean | 'configuredByTheme'>(EditorSemanticHighlightingConfiguration), signal);
			void screenshots.show({ code }, signal);
		},
	};
}
