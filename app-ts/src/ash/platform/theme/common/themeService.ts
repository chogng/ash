import type { IconFontDefinition } from './iconRegistry.js';
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
import { Disposable } from '../../../base/common/lifecycle.js';

export type ThemeColors = Readonly<Record<ColorIdentifier, string>>;

export interface ITokenStyle {
	readonly foreground?: number;
	readonly bold?: boolean;
	readonly italic?: boolean;
	readonly underline?: boolean;
	readonly strikethrough?: boolean;
}

export interface ISemanticTokenThemeRule {
	readonly bold?: boolean;
	readonly italic?: boolean;
	readonly underline?: boolean;
	readonly strikethrough?: boolean;
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
		readonly settings: { readonly foreground?: string; readonly background?: string; readonly fontStyle?: string; };
	}[];
	readonly semanticHighlighting?: boolean;
	readonly semanticTokenRules?: readonly ISemanticTokenThemeRule[];
	readonly id: string;
	readonly label: string;
	readonly colorScheme: ColorScheme;
	readonly colors: ThemeColors;
	readonly colorEntries: readonly ResolvedColorContribution[];
	readonly sizeEntries: readonly SizeContribution[];
	readonly tokenColorMap: readonly string[];
	getTokenStyleMetadata(type: string, modifiers: readonly string[], modelLanguage: string): ITokenStyle | undefined;
	defines(id: ColorIdentifier): boolean;
	getColor(id: ColorIdentifier, useDefault?: boolean): Color | undefined;
	getColorCss(id: ColorIdentifier): string | undefined;
	getSize(id: string): SizeValue | undefined;
}

/** SVG artwork selected for semantic product icon IDs in one window. */
export interface IProductIconTheme {
	readonly id: string;
	readonly label: string;
	readonly icons: ReadonlyMap<string, IconDefinition>;
	readonly fonts?: readonly IconFontDefinition[];
}

export const defaultProductIconTheme: IProductIconTheme = Object.freeze({ id: 'default', label: 'Default', icons: new Map() });

/** Capabilities of the active file icon theme, including the disabled state. */
export interface IFileIconTheme {
	readonly hasFileIcons: boolean;
	readonly hasFolderIcons: boolean;
	readonly hidesExplorerArrows: boolean;
}

export const noFileIconTheme: IFileIconTheme = Object.freeze({ hasFileIcons: false, hasFolderIcons: false, hidesExplorerArrows: false });

/** Window-scoped access to the active frontend color theme. */
export interface IThemeService {
	readonly onDidColorThemeChange: Event<IColorTheme>;
	readonly onDidProductIconThemeChange: Event<IProductIconTheme>;
	readonly onDidFileIconThemeChange: Event<IFileIconTheme>;

	getColorTheme(): IColorTheme;
	getProductIconTheme(): IProductIconTheme;
	getFileIconTheme(): IFileIconTheme;
}

export const IThemeService =
	createServiceIdentifier<IThemeService>("themeService");

/** Keeps a component's resolved theme current for its entire lifetime. */
export class Themable extends Disposable {
	protected theme: IColorTheme;

	constructor(
		protected readonly themeService: IThemeService,
	) {
		super();
		this.theme = themeService.getColorTheme();
		this._register(themeService.onDidColorThemeChange(theme => this.onThemeChange(theme)));
	}

	protected onThemeChange(theme: IColorTheme): void {
		this.theme = theme;
		this.updateStyles();
	}

	public updateStyles(): void { }
}
