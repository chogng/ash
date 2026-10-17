import { combinedDisposable, type IDisposable, toDisposable } from "../../../base/common/lifecycle.js";
import { colorCssVariable } from "../common/colorUtils.js";
import { asCssVariableName, sizeValueToCss } from "../common/sizeUtils.js";
import type { IColorTheme, IThemeService } from "../common/themeService.js";
import { ColorScheme, isDarkColorScheme } from "../common/theme.js";

interface IPreviousProperty {
	readonly value: string;
	readonly priority: string;
}

/**
 * Keeps a browser theme root synchronized with its window-scoped color theme.
 *
 * Disposing the binding restores every inline property, theme class and attribute that was
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
	rememberProperty("forced-color-adjust");
	rememberProperty("--ash-shadow-lg");
	let colorProperties = new Set<string>();

	const previousThemeId = target.getAttribute("data-color-theme");
	const previousColorScheme = target.getAttribute("data-color-scheme");
	const previousClasses = new Map(
		['hc-black', 'hc-light', 'ash-high-contrast'].map(name => [name, target.classList.contains(name)]),
	);

	const apply = (theme: IColorTheme): void => {
		const highContrastDark = theme.colorScheme === ColorScheme.HighContrastDark;
		const highContrastLight = theme.colorScheme === ColorScheme.HighContrastLight;
		// Classes and attributes describe the same active theme; neither is independent state.
		target.classList.toggle('hc-black', highContrastDark);
		target.classList.toggle('hc-light', highContrastLight);
		target.classList.toggle('ash-high-contrast', highContrastDark || highContrastLight);
		const nextProperties = new Set(theme.colorEntries.map(entry => colorCssVariable(entry.id)));
		for (const property of colorProperties) { if (!nextProperties.has(property)) { target.style.setProperty(property, "initial"); } }
		colorProperties = nextProperties;
		for (const { id, value } of theme.colorEntries) {
			rememberProperty(colorCssVariable(id));
			if (value) target.style.setProperty(colorCssVariable(id), value.toString());
			// A missing custom property would inherit a color from an outer theme root.
			else target.style.setProperty(colorCssVariable(id), "initial");
		}
		for (const { id, value } of theme.sizeEntries) {
			rememberProperty(asCssVariableName(id));
			target.style.setProperty(asCssVariableName(id), sizeValueToCss(value));
		}
		// Floating surfaces share an elevation independently of the theme's legacy widget shadow color.
		target.style.setProperty(
			"--ash-shadow-lg",
			theme.colorScheme === ColorScheme.HighContrastDark || theme.colorScheme === ColorScheme.HighContrastLight
				? "none"
				: "0 0 12px rgba(0, 0, 0, 0.14)",
		);
		target.style.setProperty(
			"color-scheme",
			isDarkColorScheme(theme.colorScheme) ? "dark" : "light",
		);
		target.style.setProperty("forced-color-adjust", theme.colorScheme === ColorScheme.HighContrastDark || theme.colorScheme === ColorScheme.HighContrastLight ? "none" : "auto");
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
		for (const [name, present] of previousClasses) {
			target.classList.toggle(name, present);
		}
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
