import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { validateNativeWindowTheme, type INativeWindowTheme } from '../../native/common/nativeHost.js';
import type { IStateService } from '../../state/node/state.js';
import type { IColorScheme } from '../../window/common/window.js';
import type { IThemeMainService } from './themeMainService.js';
import { Color } from '../../../base/common/color.js';
import { Colors } from '../common/colorRegistry.js';
import { editorBackground } from '../common/colors/editorColors.js';
import { ColorScheme } from '../common/theme.js';

interface SystemTheme {
	readonly shouldUseDarkColors: boolean;
	readonly shouldUseHighContrastColors: boolean;
	on(event: 'updated', listener: () => void): unknown;
	removeListener(event: 'updated', listener: () => void): unknown;
}

/** Main owns system appearance and the saved frame color used before a renderer loads. */
export class ThemeMainService extends Disposable implements IThemeMainService {
	private readonly changed = this._register(new Emitter<IColorScheme>());
	public readonly onDidChangeColorScheme = this.changed.event;
	private scheme: IColorScheme;
	private theme: INativeWindowTheme | undefined;
	constructor(private readonly systemTheme: SystemTheme, private readonly state: IStateService) {
		super();
		this.scheme = this.readScheme();
		const saved = state.getItem('theme.window');
		if (saved !== undefined) { this.theme = validateNativeWindowTheme(saved); }
		const update = (): void => {
			const scheme = this.readScheme();
			if (scheme.dark === this.scheme.dark && scheme.highContrast === this.scheme.highContrast) { return; }
			this.scheme = scheme;
			this.changed.fire(scheme);
		};
		systemTheme.on('updated', update);
		this._register(toDisposable(() => systemTheme.removeListener('updated', update)));
	}
	private readScheme(): IColorScheme { return { dark: this.systemTheme.shouldUseDarkColors, highContrast: this.systemTheme.shouldUseHighContrastColors }; }
	public getColorScheme(): IColorScheme { return this.scheme; }
	public getBackgroundColor(): string {
		if (this.theme) { return this.theme.backgroundColor; }
		let scheme = this.scheme.dark ? ColorScheme.Dark : ColorScheme.Light;
		if (this.scheme.highContrast) {
			scheme = this.scheme.dark ? ColorScheme.HighContrastDark : ColorScheme.HighContrastLight;
		}
		const background = Colors.resolve(scheme).find(color => color.id === editorBackground)?.value;
		if (!background) { throw new Error('The startup theme must define an editor background'); }
		return Color.Format.CSS.formatHex(background);
	}
	public async saveWindowTheme(theme: INativeWindowTheme): Promise<void> {
		this.theme = theme;
		this.state.setItem('theme.window', theme);
		await this.state.flush();
	}
}
