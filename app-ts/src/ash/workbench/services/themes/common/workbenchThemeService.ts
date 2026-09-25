import type { IProductIconTheme } from '../../../../platform/theme/common/themeService.js';

export interface FileIconDefinition {
	readonly character: string;
	readonly color: string;
	readonly fontFamily: string;
	readonly fontSize: string;
	readonly image: string;
}

export interface IWorkbenchFileIconTheme {
	readonly id: string;
	readonly label: string;
	readonly styleSheetContent: string;
	resolveFileIcon(classes: readonly string[], dark: boolean): FileIconDefinition | undefined;
}

/** SVG replacements for registered product icon IDs. Unspecified IDs retain their built-in artwork. */
export interface IWorkbenchProductIconTheme extends IProductIconTheme { }

