import type { IColorTheme } from "../../platform/theme/common/colorTheme.js";
import { createServiceIdentifier } from "../../platform/instantiation/common/instantiation.js";
import type { ColorScheme } from "../../platform/theme/common/theme.js";

export interface IUserThemeLoadIssue {
	readonly file: string;
	readonly message: string;
}

export interface IUserThemeSource {
	readonly id: string;
	readonly file: string;
}

export interface IUserThemeSaveResult {
	readonly file: string;
	readonly theme: IColorTheme;
}

export interface IUserThemeDeleteResult {
	readonly colorScheme: ColorScheme;
	readonly file: string;
}

/** Window capability for reading, creating, replacing, and reloading user themes. */
export interface IUserThemeService {
	readonly available: boolean;
	readonly directory: string | undefined;
	readonly issues: readonly IUserThemeLoadIssue[];

	sourceFor(themeId: string): IUserThemeSource | undefined;
	getSource(themeId: string): string | undefined;
	delete(themeId: string): Promise<IUserThemeDeleteResult>;
	reload(): Promise<void>;
	save(themeId: string, source: string): Promise<IUserThemeSaveResult>;
	saveAs(source: string): Promise<IUserThemeSaveResult>;
}

export const IUserThemeService = createServiceIdentifier<IUserThemeService>("userThemeService");

/** Browser-host fallback used when the host cannot persist user theme files. */
export const UnavailableUserThemeService: IUserThemeService = Object.freeze({
	available: false,
	directory: undefined,
	issues: Object.freeze([]),
	sourceFor: () => undefined,
	getSource: () => undefined,
	delete: () => Promise.reject(new Error("User themes are not available in this host")),
	reload: () => Promise.resolve(),
	save: () => Promise.reject(new Error("User themes are not available in this host")),
	saveAs: () => Promise.reject(new Error("User themes are not available in this host")),
});
