import { Emitter, type Event } from "../../base/common/event.js";
import { type IDisposable, toDisposable } from "../../base/common/lifecycle.js";
import { darkColorTheme, type IColorTheme, lightColorTheme } from "../../platform/theme/common/colorTheme.js";

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
