import type { Event } from "../../../base/common/event.js";
import type { IconDefinition } from "../../../base/common/icon.js";
import type { Color } from "../../../base/common/color.js";
import {
	createServiceIdentifier,
} from "../../instantiation/common/instantiation.js";
import type { ColorIdentifier, ResolvedColorContribution } from "./colorRegistry.js";
import type { SizeContribution } from "./sizeRegistry.js";
import type { SizeValue } from "./sizeUtils.js";
import type { ColorScheme } from "./theme.js";

export type ThemeColors = Readonly<Record<ColorIdentifier, string>>;

export interface ISemanticTokenThemeRule {
	readonly selector: string;
	readonly type: string;
	readonly modifiers: readonly string[];
	readonly language?: string;
	readonly foreground?: string;
	readonly fontStyle?: string;
}

/** Resolved color and size values exposed to editor and Workbench consumers. */
export interface IColorTheme {
	readonly tokenColors?: readonly {
		readonly scopes: readonly string[];
		readonly settings: { readonly foreground?: string; readonly background?: string; readonly fontStyle?: string };
	}[];
	readonly semanticHighlighting?: boolean;
	readonly semanticTokenRules?: readonly ISemanticTokenThemeRule[];
	readonly id: string;
	readonly label: string;
	readonly colorScheme: ColorScheme;
	readonly colors: ThemeColors;
	readonly colorEntries: readonly ResolvedColorContribution[];
	readonly sizeEntries: readonly SizeContribution[];
	getColor(id: ColorIdentifier): Color | undefined;
	getColorCss(id: ColorIdentifier): string | undefined;
	getSize(id: string): SizeValue | undefined;
}

/** SVG artwork selected for semantic product icon IDs in one window. */
export interface IProductIconTheme {
	readonly id: string;
	readonly label: string;
	readonly icons: ReadonlyMap<string, IconDefinition>;
}

export const defaultProductIconTheme: IProductIconTheme = Object.freeze({ id: 'default', label: 'Default', icons: new Map() });

/** Window-scoped access to the active frontend color theme. */
export interface IThemeService {
	readonly onDidColorThemeChange: Event<IColorTheme>;
	readonly onDidProductIconThemeChange: Event<IProductIconTheme>;

	getColorTheme(): IColorTheme;
	getProductIconTheme(): IProductIconTheme;
}

export const IThemeService =
	createServiceIdentifier<IThemeService>("themeService");
