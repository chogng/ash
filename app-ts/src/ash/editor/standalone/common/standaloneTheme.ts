import type { ColorScheme } from '../../../platform/theme/common/theme.js';
import { IThemeService, type IColorTheme } from '../../../platform/theme/common/themeService.js';
import type { ServiceIdentifier } from '../../../platform/instantiation/common/instantiation.js';
import type { Color } from '../../../base/common/color.js';
import type { ITokenThemeRule, TokenTheme } from '../../common/languages/supports/tokenization.js';

export const IStandaloneThemeService = IThemeService as ServiceIdentifier<IStandaloneThemeService>;

export type BuiltinTheme = 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';
export type IColors = { [colorId: string]: string };

export interface IStandaloneThemeData {
	base: BuiltinTheme;
	inherit: boolean;
	rules: ITokenThemeRule[];
	encodedTokensColors?: string[];
	colors: IColors;
}

export interface IStandaloneTheme extends IColorTheme {
	readonly tokenTheme: TokenTheme;
	readonly themeName: string;
}

/** Complete standalone theme input compiled against the shared token registry. */
export interface NamedEditorThemeData {
	readonly label: string;
	readonly colorScheme: ColorScheme;
	readonly colors?: Readonly<Record<string, string>>;
}

/** Window-scoped standalone theme selection and registration. */
export interface IStandaloneThemeService extends IThemeService {
	defineTheme(themeName: string, themeData: IStandaloneThemeData): void;
	getColorTheme(): IStandaloneTheme;
	setColorMapOverride(colorMapOverride: Color[] | null): void;
	defineNamedTheme(themeId: string, themeData: NamedEditorThemeData): void;
	setTheme(themeId: string): void;
	setAutoDetectHighContrast(autoDetectHighContrast: boolean): void;
}
