import type { Event } from '../../../base/common/event.js';
import type { INativeWindowTheme } from '../../native/common/nativeHost.js';
import type { IColorScheme } from '../../window/common/window.js';

export interface IThemeMainService {
	readonly onDidChangeColorScheme: Event<IColorScheme>;
	getColorScheme(): IColorScheme;
	getBackgroundColor(): string;
	saveWindowTheme(theme: INativeWindowTheme): Promise<void>;
}
