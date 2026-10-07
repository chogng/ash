import { localize2 } from '../../../../nls.js';
import { darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme, lightColorTheme } from '../../../../platform/theme/common/colorTheme.js';
import { ColorScheme, isDarkColorScheme } from '../../../../platform/theme/common/theme.js';
import { EditorAction, registerEditorAction, type ServicesAccessor } from '../../../browser/editorExtensions.js';
import { IStandaloneThemeService } from '../../common/standaloneTheme.js';

class ToggleHighContrast extends EditorAction {
	private readonly normalThemes = new WeakMap<IStandaloneThemeService, string>();

	constructor() {
		super({
			id: 'editor.action.toggleHighContrast',
			label: localize2('toggleHighContrast.label', 'Toggle High Contrast Theme'),
			precondition: undefined,
		});
	}

	public run(accessor: ServicesAccessor): void {
		const themes = accessor.get(IStandaloneThemeService);
		const current = themes.getColorTheme();
		const dark = isDarkColorScheme(current.colorScheme);
		if (current.colorScheme === ColorScheme.HighContrastDark || current.colorScheme === ColorScheme.HighContrastLight) {
			const theme = this.normalThemes.get(themes) ?? (dark ? darkColorTheme.id : lightColorTheme.id);
			this.normalThemes.delete(themes);
			themes.setTheme(theme);
			return;
		}
		this.normalThemes.set(themes, current.id);
		themes.setTheme(dark ? highContrastDarkColorTheme.id : highContrastLightColorTheme.id);
	}
}

registerEditorAction(ToggleHighContrast);
