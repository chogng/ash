import { combinedDisposable, type IDisposable, toDisposable } from "../../../base/common/lifecycle.js";
import { colorCssVariable } from "../common/colorUtils.js";
import { asCssVariableName, sizeValueToCss } from "../common/sizeUtils.js";
import type { IColorTheme, IThemeService } from "../common/themeService.js";
import { isDarkColorScheme } from "../common/theme.js";

interface IPreviousProperty {
	readonly value: string;
	readonly priority: string;
}

/**
 * Keeps a browser theme root synchronized with its window-scoped color theme.
 *
 * Disposing the binding restores every inline property and attribute that was
 * present before the theme was applied.
 */
export function bindColorTheme(
	themeService: IThemeService,
	target: HTMLElement,
): IDisposable {
	const previousProperties = new Map<string, IPreviousProperty>();
	const rememberProperty = (property: string): void => {
		if (previousProperties.has(property)) return;
		previousProperties.set(property, {
			value: target.style.getPropertyValue(property),
			priority: target.style.getPropertyPriority(property),
		});
	};
	rememberProperty("color-scheme");

	const previousThemeId = target.getAttribute("data-color-theme");
	const previousColorScheme = target.getAttribute("data-color-scheme");

	const apply = (theme: IColorTheme): void => {
		for (const { id, value } of theme.colorEntries) {
			rememberProperty(colorCssVariable(id));
			if (value) target.style.setProperty(colorCssVariable(id), value.toString());
			else target.style.removeProperty(colorCssVariable(id));
		}
		for (const { id, value } of theme.sizeEntries) {
			rememberProperty(asCssVariableName(id));
			target.style.setProperty(asCssVariableName(id), sizeValueToCss(value));
		}
		target.style.setProperty(
			"color-scheme",
			isDarkColorScheme(theme.colorScheme) ? "dark" : "light",
		);
		target.setAttribute("data-color-theme", theme.id);
		target.setAttribute("data-color-scheme", theme.colorScheme);
	};

	apply(themeService.getColorTheme());
	const listener = themeService.onDidColorThemeChange(apply);
	const restoration = toDisposable(() => {
		for (const [property, previous] of previousProperties) {
			if (previous.value) {
				target.style.setProperty(
					property,
					previous.value,
					previous.priority,
				);
			} else {
				target.style.removeProperty(property);
			}
		}
		restoreAttribute(target, "data-color-theme", previousThemeId);
		restoreAttribute(target, "data-color-scheme", previousColorScheme);
	});

	return combinedDisposable(restoration, listener);
}

function restoreAttribute(
	target: HTMLElement,
	name: string,
	value: string | null,
): void {
	if (value === null) target.removeAttribute(name);
	else target.setAttribute(name, value);
}
