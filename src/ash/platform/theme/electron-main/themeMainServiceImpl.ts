import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { IStateService } from '../../state/node/state.js';
import type { IColorScheme } from '../../window/common/window.js';
import type { IThemeMainService } from './themeMainService.js';
import { Color } from '../../../base/common/color.js';
import { Colors } from '../common/colorRegistry.js';
import { editorBackground } from '../common/colors/editorColors.js';
import { ColorScheme } from '../common/theme.js';
import { foreground } from '../common/colors/baseColors.js';
import { validatePartsSplash, type IPartsSplash } from '../common/themeService.js';

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
	constructor(
		private readonly systemTheme: SystemTheme,
		private readonly state: IStateService,
	) {
		super();
		this.scheme = this.readScheme();
		const update = (): void => {
			const scheme = this.readScheme();
			if (scheme.dark === this.scheme.dark && scheme.highContrast === this.scheme.highContrast) {
				return;
			}
			this.scheme = scheme;
			this.changed.fire(scheme);
		};
		systemTheme.on('updated', update);
		this._register(toDisposable(() => systemTheme.removeListener('updated', update)));
	}
	private readScheme(): IColorScheme {
		return {
			dark: this.systemTheme.shouldUseDarkColors,
			highContrast: this.systemTheme.shouldUseHighContrastColors,
		};
	}
	public getColorScheme(): IColorScheme {
		return this.scheme;
	}
	public getBackgroundColor(scope = 'workbench'): string {
		return this.getWindowSplash(scope).colorInfo.background;
	}
	public getWindowSplash(scope: string): IPartsSplash {
		const saved = this.state.getItem(`windowSplash.${scope}`);
		if (saved !== undefined) {
			try {
				return validatePartsSplash(saved);
			} catch {
				/* A rendering cache can be discarded without losing user state. */
			}
		}
		let scheme = this.scheme.dark ? ColorScheme.Dark : ColorScheme.Light;
		if (this.scheme.highContrast) {
			scheme = this.scheme.dark ? ColorScheme.HighContrastDark : ColorScheme.HighContrastLight;
		}
		const colors = Colors.resolve(scheme);
		const background = colors.find(color => color.id === editorBackground)?.value;
		const text = colors.find(color => color.id === foreground)?.value;
		if (!background || !text) {
			throw new Error('The startup theme must define background and foreground colors');
		}
		return {
			baseTheme: scheme,
			colorInfo: {
				background: Color.Format.CSS.formatHex(background),
				foreground: Color.Format.CSS.formatHex(text),
			},
		};
	}
	public async saveWindowSplash(scope: string, splash: IPartsSplash): Promise<void> {
		this.state.setItem(`windowSplash.${scope}`, splash);
		await this.state.flush();
	}
}
