import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { createColorTheme, darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme, type IColorTheme, lightColorTheme } from '../../../platform/theme/common/colorTheme.js';
import { ColorScheme, isDarkColorScheme } from '../../../platform/theme/common/theme.js';
import type { INamedEditorThemeService, NamedEditorThemeData } from '../common/namedEditorTheme.js';

const ForcedColorsQuery = '(forced-colors: active)';

/** Owns named themes and the active theme for one standalone browser window. */
export class NamedEditorThemeService extends Disposable implements INamedEditorThemeService {
	private readonly changed = this._register(new Emitter<IColorTheme>());
	private colorTheme: IColorTheme = lightColorTheme;
	public readonly onDidColorThemeChange = this.changed.event;
	private readonly themes = new Map<string, IColorTheme>();
	private readonly forcedColors: MediaQueryList;
	private selectedThemeId = lightColorTheme.id;
	private autoDetectHighContrast = true;

	constructor(ownerWindow: Window) {
		super();
		for (const theme of [lightColorTheme, darkColorTheme, highContrastLightColorTheme, highContrastDarkColorTheme]) {
			this.themes.set(theme.id, theme);
		}
		this.forcedColors = ownerWindow.matchMedia(ForcedColorsQuery);
		const handleForcedColorsChange = (): void => this.applySelectedTheme();
		this.forcedColors.addEventListener('change', handleForcedColorsChange);
		this._register(toDisposable(() => this.forcedColors.removeEventListener('change', handleForcedColorsChange)));
		this.applySelectedTheme();
	}

	public defineNamedTheme(themeId: string, themeData: NamedEditorThemeData): void {
		const theme = createColorTheme({
			id: themeId,
			label: themeData.label,
			colorScheme: themeData.colorScheme,
			colorOverrides: themeData.colors,
		});
		this.themes.set(themeId, theme);
		if (this.selectedThemeId === themeId || this.getColorTheme().id === themeId) {
			this.applySelectedTheme();
		}
	}

	public setTheme(themeId: string): void {
		if (!this.themes.has(themeId)) {
			throw new Error(`Unknown standalone color theme: ${themeId}`);
		}
		this.selectedThemeId = themeId;
		this.applySelectedTheme();
	}

	public getColorTheme(): IColorTheme {
		return this.colorTheme;
	}

	public setColorTheme(theme: IColorTheme): void {
		this.themes.set(theme.id, theme);
		this.selectedThemeId = theme.id;
		this.applySelectedTheme();
	}

	public setAutoDetectHighContrast(autoDetectHighContrast: boolean): void {
		if (this.autoDetectHighContrast === autoDetectHighContrast) {
			return;
		}
		this.autoDetectHighContrast = autoDetectHighContrast;
		this.applySelectedTheme();
	}

	private applySelectedTheme(): void {
		const selectedTheme = this.themes.get(this.selectedThemeId);
		if (!selectedTheme) {
			throw new Error(`Unknown standalone color theme: ${this.selectedThemeId}`);
		}
		if (!this.autoDetectHighContrast || !this.forcedColors.matches || isHighContrast(selectedTheme.colorScheme)) {
			this.updateColorTheme(selectedTheme);
			return;
		}
		const highContrastTheme = isDarkColorScheme(selectedTheme.colorScheme) ? highContrastDarkColorTheme : highContrastLightColorTheme;
		const registeredHighContrastTheme = this.themes.get(highContrastTheme.id);
		if (!registeredHighContrastTheme) {
			throw new Error(`Unknown standalone color theme: ${highContrastTheme.id}`);
		}
		this.updateColorTheme(registeredHighContrastTheme);
	}

	private updateColorTheme(theme: IColorTheme): void {
		if (theme === this.colorTheme) {
			return;
		}
		this.colorTheme = theme;
		this.changed.fire(theme);
	}
}

function isHighContrast(colorScheme: ColorScheme): boolean {
	return colorScheme === ColorScheme.HighContrastDark || colorScheme === ColorScheme.HighContrastLight;
}
