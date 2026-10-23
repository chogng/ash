import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { InMemoryConfigurationService } from '../../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { BrowserContextViewService } from '../../../../../../platform/contextview/browser/contextViewService.js';
import { bindTestColorTheme } from '../../../../../../../../test/fixtures/browser/themeFixture.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../../../../platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../../../../platform/theme/test/common/testThemeService.js';
import { ModelPickerWidget, type ModelPickerPresentation } from '../../../browser/modelPickerWidget.js';

declare global {
	interface Window {
		ashModelPickerIntegration: {
			configure(options: { thinking?: boolean; disabled?: boolean; singleLevel?: boolean; longTitle?: boolean; secondWithoutThinking?: boolean; emphasizedLevel?: string; }): void;
			dispose(): void;
		};
	}
}

const resources = new DisposableStore();
const themes = { light: lightColorTheme, dark: darkColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme };
const themeName = new URLSearchParams(location.search).get('theme') ?? 'light';
const theme = resources.add(new TestThemeService(themes[themeName as keyof typeof themes]));
resources.add(bindTestColorTheme(theme, document.body));
const views = resources.add(new BrowserContextViewService(document.body));
const configuration = resources.add(new InMemoryConfigurationService());
const levels = [
	{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' },
	{ id: 'extraHigh', label: 'Extra High' }, { id: 'max', label: 'Max' },
];
let presentation: ModelPickerPresentation = {
	models: [{ id: 'one', title: 'First model' }, { id: 'two', title: 'Second model' }],
	selectedModel: 'one', disabled: false,
};
const widget = resources.add(new ModelPickerWidget(document.querySelector('#composer')!, model => {
	presentation = { ...presentation, selectedModel: model, thinking: model === 'two' && secondWithoutThinking ? undefined : presentation.thinking };
	render(model);
}, views, configuration));
let secondWithoutThinking = false;
let emphasizedLevel: string | undefined;
function render(selection?: string): void {
	widget.update(presentation);
	if (selection) { document.querySelector('output')!.textContent = selection; }
}
render();
window.ashModelPickerIntegration = {
	configure(options) {
		secondWithoutThinking = options.secondWithoutThinking ?? false;
		emphasizedLevel = options.emphasizedLevel;
		presentation = {
			...presentation, disabled: options.disabled ?? false,
			models: options.longTitle ? [{ id: 'one', title: 'A very long model title '.repeat(15) }, { id: 'two', title: 'Second model' }] : presentation.models,
			thinking: options.thinking ? {
				levels: options.singleLevel ? levels.slice(0, 1) : levels,
				selectedLevel: options.singleLevel ? 'low' : 'extraHigh',
				emphasized: emphasizedLevel === (options.singleLevel ? 'low' : 'extraHigh'),
				select(level) {
					presentation = { ...presentation, thinking: { ...presentation.thinking!, selectedLevel: level, emphasized: level === emphasizedLevel } };
					render(level);
				},
			} : undefined,
		};
		render();
	},
	dispose: () => widget.dispose(),
};
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
