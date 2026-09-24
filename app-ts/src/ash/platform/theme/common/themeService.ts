import type { Event } from "../../../base/common/event.js";
import {
	createServiceIdentifier,
} from "../../instantiation/common/instantiation.js";
import type { IColorTheme } from "./colorTheme.js";

/** Window-scoped access to the active frontend color theme. */
export interface IThemeService {
	readonly onDidColorThemeChange: Event<IColorTheme>;

	getColorTheme(): IColorTheme;
}

export const IThemeService =
	createServiceIdentifier<IThemeService>("themeService");
