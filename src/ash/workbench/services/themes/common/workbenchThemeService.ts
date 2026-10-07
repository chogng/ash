import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IColorTheme, IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { ColorScheme } from '../../../../platform/theme/common/theme.js';
import type { IFileIconTheme, IProductIconTheme } from '../../../../platform/theme/common/themeService.js';

export interface FileIconDefinition {
	readonly character: string;
	readonly color: string;
	readonly fontFamily: string;
	readonly fontSize: string;
	readonly fontWeight: string;
	readonly fontStyle: string;
	readonly image: string;
}

export interface IWorkbenchFileIconTheme extends IFileIconTheme {
	readonly id: string;
	readonly label: string;
	readonly styleSheetContent: string;
	resolveFileIcon(classes: readonly string[], colorScheme: ColorScheme): FileIconDefinition | undefined;
}

/** SVG replacements for registered product icon IDs. Unspecified IDs retain their built-in artwork. */
export interface IWorkbenchProductIconTheme extends IProductIconTheme { }


export interface IColorCustomizations { [colorOrThemeScope: string]: string | Readonly<Record<string, string>>; }

/** Theme selection updates the currently active system preference when automatic appearance is enabled. */
export interface IWorkbenchThemeService extends IThemeService {
	setColorTheme(themeId: string): Promise<IColorTheme>;
}
export const IWorkbenchThemeService = createServiceIdentifier<IWorkbenchThemeService>('workbenchThemeService');
