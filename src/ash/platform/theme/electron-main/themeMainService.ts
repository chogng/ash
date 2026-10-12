import type { Event } from '../../../base/common/event.js';
import type { IColorScheme } from '../../window/common/window.js';
import type { IPartsSplash } from '../common/themeService.js';

export interface IThemeMainService {
	readonly onDidChangeColorScheme: Event<IColorScheme>;
	getColorScheme(): IColorScheme;
	getBackgroundColor(scope?: string): string;
	getWindowSplash(scope: string): IPartsSplash;
	saveWindowSplash(scope: string, splash: IPartsSplash): Promise<void>;
}
