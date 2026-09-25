import { Emitter, type Event } from "../../base/common/event.js";
import { type IDisposable, toDisposable } from "../../base/common/lifecycle.js";
import { registerColor } from "../../platform/theme/common/colorUtils.js";
import { accentBackground, border, contrastBorder, descriptionForeground, foreground, selectionBackground } from "../../platform/theme/common/colors/baseColors.js";
import { darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme, lightColorTheme } from "../../platform/theme/common/colorTheme.js";
import type { IColorTheme } from "../../platform/theme/common/themeService.js";

const colorOwner = "workbench.shell";
const color = (id: string, dark: string, light: string, highContrastDark: string, highContrastLight: string, description: string): string =>
	registerColor(id, { dark, light, highContrastDark, highContrastLight }, { description, owner: colorOwner });
const alias = (id: string, value: string, description: string): string =>
	registerColor(id, { dark: value, light: value, highContrastDark: value, highContrastLight: value }, { description, owner: colorOwner });

alias("sectionHeader.foreground", descriptionForeground, "Section header foreground.");
color("workbench.background", "#1e1e1e", "#ffffff", "#000000", "#ffffff", "Workbench root background.");
registerColor("editorGroup.border", {
	dark: border,
	light: border,
	highContrastDark: contrastBorder,
	highContrastLight: contrastBorder,
}, { description: "Border between editor groups.", owner: colorOwner });
color("editor.tabBackground", "#EEEEEE", "#EEEEEE", "#000000", "#ffffff", "Background for inactive Editor tabs.");

export const titleBarBackground = color("titleBar.background", "#FFFFFF", "#FFFFFF", "#000000", "#ffffff", "Title bar background.");
color("titleBar.foreground", "#1f1f1f", "#1f1f1f", foreground, foreground, "Title bar foreground.");
export const titleBarActionForeground = color("titleBar.actionForeground", "#424242", "#424242", foreground, foreground, "Title bar action foreground.");
color("titleBar.hoverBackground", "#e5e5e5", "#e5e5e5", "#333333", "#dddddd", "Hovered title bar item background.");
registerColor('commandCenter.foreground', { dark: '#424242', light: '#424242', highContrastDark: '#ffffff', highContrastLight: '#000000' }, { description: 'Command Center search text and icon.', owner: colorOwner });
registerColor('commandCenter.background', { dark: '#f6f6f6', light: '#f6f6f6', highContrastDark: '#000000', highContrastLight: '#ffffff' }, { description: 'Command Center search background.', owner: colorOwner });
registerColor('commandCenter.border', { dark: '#d0d0d0', light: '#d0d0d0', highContrastDark: contrastBorder, highContrastLight: contrastBorder }, { description: 'Command Center search border.', owner: colorOwner });
registerColor('commandCenter.hoverBackground', { dark: '#ebebeb', light: '#ebebeb', highContrastDark: '#333333', highContrastLight: '#dddddd' }, { description: 'Hovered Command Center search background.', owner: colorOwner });
registerColor('commandCenter.activeBorder', { dark: '#888888', light: '#888888', highContrastDark: contrastBorder, highContrastLight: contrastBorder }, { description: 'Active Command Center search border.', owner: colorOwner });

const sideBarBackground = color("sideBar.background", "#F8F8F8", "#F8F8F8", "#000000", "#ffffff", "Primary side bar background.");
alias("auxiliaryBar.background", sideBarBackground, "Auxiliary side bar background.");
alias("panel.background", sideBarBackground, "Panel background.");
const emptyExplorerOpenFolderBackground = registerColor("files.emptyExplorerOpenFolderBackground", {
	dark: accentBackground, light: accentBackground,
	highContrastDark: selectionBackground, highContrastLight: selectionBackground,
}, { description: "Background for the Empty Explorer Open Folder action.", owner: "files.presentation" });
registerColor("files.emptyExplorerOpenFolderHoverBackground", {
	dark: emptyExplorerOpenFolderBackground, light: emptyExplorerOpenFolderBackground,
	highContrastDark: emptyExplorerOpenFolderBackground, highContrastLight: emptyExplorerOpenFolderBackground,
}, { description: "Hovered background for the Empty Explorer Open Folder action.", owner: "files.presentation" });
color("compositeBar.foreground", "#ffffff", "#1f1f1f", foreground, foreground, "Active composite bar foreground.");
color("compositeBar.inactiveForeground", "#858585", "#616161", foreground, foreground, "Inactive composite bar foreground.");

const statusBarForeground = color("statusBar.foreground", "#1f1f1f", "#1f1f1f", foreground, foreground, "Status bar foreground.");
color("statusBar.background", "#FFFFFF", "#FFFFFF", "#000000", "#ffffff", "Status bar background.");
const statusBarItemHoverForeground = alias("statusBarItem.hoverForeground", statusBarForeground, "Hovered status bar item foreground.");
const statusBarItemHoverBackground = color(
	"statusBarItem.hoverBackground", "#5a5d5e50", "#5a5d5e29", "#333333", "#dddddd", "Hovered status bar item background.",
);
alias("statusBarItem.compactHoverBackground", statusBarItemHoverBackground, "Overlay for the hovered member of a compact status bar group.");
color("statusBarItem.activeBackground", "#37373d", "#dcdcdc", "#333333", "#dddddd", "Pressed status bar item background.");
color("statusBarItem.remoteForeground", "#FFFFFF", "#FFFFFF", foreground, foreground, "Remote status bar item foreground.");
alias("statusBarItem.remoteBackground", accentBackground, "Remote status bar item background.");
alias("statusBarItem.remoteHoverForeground", statusBarItemHoverForeground, "Hovered remote status bar item foreground.");
alias("statusBarItem.remoteHoverBackground", statusBarItemHoverBackground, "Hovered remote status bar item background.");

/** Configuration value that delegates the active theme to the operating system. */
export const SystemColorThemePreference = "system";

/** One caller-owned set of selectable themes that can be atomically replaced. */
export interface WorkbenchThemeRegistration extends IDisposable {
	replace(themes: readonly IColorTheme[]): void;
}

/**
 * Registry of complete color themes that can be selected by the workbench.
 *
 * Theme contributions must provide every color required by `IColorTheme`.
 */
export class WorkbenchThemeRegistry {
	private readonly _onDidChange = new Emitter<readonly IColorTheme[]>();
	private readonly themes = new Map<string, { readonly owner: object; readonly theme: IColorTheme }>();

	readonly onDidChange: Event<readonly IColorTheme[]> = this._onDidChange.event;

	constructor(initialThemes: readonly IColorTheme[] = []) {
		const owner = Object.freeze({});
		this.validateReplacement(owner, initialThemes);
		for (const theme of initialThemes) this.themes.set(theme.id, { owner, theme });
	}

	registerColorTheme(theme: IColorTheme): IDisposable {
		return this.registerColorThemes([theme]);
	}

	registerColorThemes(themes: readonly IColorTheme[]): WorkbenchThemeRegistration {
		const owner = Object.freeze({});
		this.validateReplacement(owner, themes);
		this.replace(owner, themes);
		let disposed = false;
		const registration = toDisposable(() => {
			if (disposed) return;
			disposed = true;
			if (this.deleteOwner(owner)) this.publish();
		}) as WorkbenchThemeRegistration;
		registration.replace = replacement => {
			if (disposed) throw new ReferenceError("Workbench theme registration is already disposed");
			this.validateReplacement(owner, replacement);
			this.replace(owner, replacement);
		};
		return registration;
	}

	getColorTheme(id: string): IColorTheme | undefined {
		return this.themes.get(id)?.theme;
	}

	getColorThemes(): readonly IColorTheme[] {
		return Object.freeze([...this.themes.values()].map(entry => entry.theme));
	}

	private validateReplacement(owner: object, themes: readonly IColorTheme[]): void {
		if (!Array.isArray(themes)) throw new TypeError("Workbench color themes must be an array");
		const ids = new Set<string>();
		for (const theme of themes) {
			if (typeof theme !== "object" || theme === null || !theme.id.trim()) throw new TypeError("Workbench color theme ID must not be empty");
			if (ids.has(theme.id)) throw new Error(`Workbench color theme is already registered: ${theme.id}`);
			ids.add(theme.id);
			const existing = this.themes.get(theme.id);
			if (existing && existing.owner !== owner) throw new Error(`Workbench color theme is already registered: ${theme.id}`);
		}
	}

	private replace(owner: object, themes: readonly IColorTheme[]): void {
		const changed = this.deleteOwner(owner) || themes.length > 0;
		for (const theme of themes) this.themes.set(theme.id, { owner, theme });
		if (changed) this.publish();
	}

	private deleteOwner(owner: object): boolean {
		let changed = false;
		for (const [id, entry] of this.themes) {
			if (entry.owner !== owner) continue;
			this.themes.delete(id);
			changed = true;
		}
		return changed;
	}

	private publish(): void {
		this._onDidChange.fire(this.getColorThemes());
	}
}

/** Built-in and contributed color themes selectable by configuration. */
export const WorkbenchThemesRegistry = new WorkbenchThemeRegistry([
	lightColorTheme,
	darkColorTheme,
	highContrastLightColorTheme,
	highContrastDarkColorTheme,
]);

/** Theme preference used before persisted configuration has been loaded. */
export const defaultWorkbenchColorThemePreference =
	SystemColorThemePreference;

/** Resolves a validated theme identifier for a workbench window. */
export function getWorkbenchColorTheme(id: string): IColorTheme {
	const theme = WorkbenchThemesRegistry.getColorTheme(id);
	if (!theme) throw new Error(`Unknown workbench color theme: ${id}`);
	return theme;
}

/** Resolves a persisted theme preference against the current system scheme. */
export function resolveWorkbenchColorTheme(
	preference: string,
	systemPrefersDark: boolean,
): IColorTheme {
	if (preference === SystemColorThemePreference) {
		return systemPrefersDark ? darkColorTheme : lightColorTheme;
	}
	return getWorkbenchColorTheme(preference);
}
