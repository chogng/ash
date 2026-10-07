import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { validateNativeWindowTheme, type INativeWindowTheme } from '../../native/common/nativeHost.js';
import type { IStateService } from '../../state/node/state.js';
import type { IColorScheme } from '../../window/common/window.js';
import type { IThemeMainService } from './themeMainService.js';

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
	public getBackgroundColor(): string { return this.theme?.backgroundColor ?? (this.scheme.dark ? '#181818' : '#ffffff'); }
	public async saveWindowTheme(theme: INativeWindowTheme): Promise<void> {
		this.theme = theme;
		this.state.setItem('theme.window', theme);
		await this.state.flush();
	}
}
