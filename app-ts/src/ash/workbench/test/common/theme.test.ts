import { strict as assert } from "node:assert";
import { test } from "mocha";
import { createColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from "../../../platform/theme/common/colorTheme.js";
import { ColorScheme } from "../../../platform/theme/common/theme.js";
import { WorkbenchThemeRegistry, WorkbenchThemesRegistry } from "../../common/theme.js";

test('built-in high contrast themes keep common foreground and background pairs readable', () => {
	assert.deepEqual(WorkbenchThemesRegistry.getColorThemes().filter(theme => theme.colorScheme.startsWith('high-contrast')).map(theme => theme.id), [
		highContrastLightColorTheme.id,
		highContrastDarkColorTheme.id,
	]);
	const pairs = [
		['foreground', 'workbench.background'],
		['editor.foreground', 'editor.background'],
		['input.foreground', 'input.background'],
		['button.foreground', 'button.background'],
		['button.primaryForeground', 'button.primaryBackground'],
		['button.primaryForeground', 'button.primaryHoverBackground'],
		['list.activeSelectionForeground', 'list.activeSelectionBackground'],
		['menu.selectionForeground', 'menu.selectionBackground'],
		['foreground', 'list.hoverBackground'],
		['foreground', 'toolbar.hoverBackground'],
		['foreground', 'actionBar.toggledBackground'],
		['foreground', 'tabList.activeBackground'],
		['foreground', 'tabList.hoverBackground'],
		['titleBar.foreground', 'titleBar.hoverBackground'],
		['menu.foreground', 'menu.hoverBackground'],
		['statusBar.foreground', 'statusBar.background'],
		['statusBar.foreground', 'statusBarItem.hoverBackground'],
		['statusBarItem.remoteForeground', 'statusBarItem.remoteBackground'],
	] as const;
	for (const theme of [highContrastDarkColorTheme, highContrastLightColorTheme]) {
		for (const [foreground, background] of pairs) {
			const text = theme.getColor(foreground);
			const surface = theme.getColor(background);
			assert.ok(text && surface);
			assert.ok(contrastRatio(text.rgba, surface.rgba) >= 7, `${theme.id}: ${foreground} on ${background}`);
		}
	}
});

test("a contributed Workbench theme set can replace its own stable IDs", () => {
	const registry = new WorkbenchThemeRegistry();
	using registration = registry.registerColorThemes([theme("extension-demo-dark", "Dark")]);

	registration.replace([theme("extension-demo-dark", "Updated Dark"), theme("extension-demo-light", "Light", ColorScheme.Light)]);

	assert.equal(registry.getColorTheme("extension-demo-dark")?.label, "Updated Dark");
	assert.equal(registry.getColorTheme("extension-demo-light")?.colorScheme, ColorScheme.Light);
});

test("a contributed Workbench theme replacement preserves other owners on conflict", () => {
	const registry = new WorkbenchThemeRegistry();
	using external = registry.registerColorTheme(theme("external-dark", "External"));
	using registration = registry.registerColorThemes([theme("extension-demo-dark", "Demo")]);

	assert.throws(() => registration.replace([theme("external-dark", "Conflict")]), /already registered/);
	assert.equal(registry.getColorTheme("extension-demo-dark")?.label, "Demo");
	assert.equal(registry.getColorTheme("external-dark")?.label, "External");
});

test("Workbench theme changes publish one immutable catalog after registration, replacement, and disposal", () => {
	const registry = new WorkbenchThemeRegistry();
	const catalogs: Array<readonly ReturnType<typeof theme>[]> = [];
	using listener = registry.onDidChange(themes => catalogs.push(themes));
	const registration = registry.registerColorThemes([theme("extension-demo-dark", "Demo")]);

	registration.replace([theme("extension-demo-light", "Light", ColorScheme.Light)]);
	registration.dispose();

	assert.deepEqual(catalogs.map(catalog => catalog.map(candidate => candidate.id)), [["extension-demo-dark"], ["extension-demo-light"], []]);
	assert.equal(Object.isFrozen(catalogs[0]), true);
});

function theme(id: string, label: string, colorScheme = ColorScheme.Dark) {
	return createColorTheme({ id, label, colorScheme });
}

function contrastRatio(foreground: { r: number; g: number; b: number }, background: { r: number; g: number; b: number }): number {
	const luminance = (color: { r: number; g: number; b: number }): number => {
		const linear = (channel: number): number => {
			const value = channel / 255;
			return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
		};
		return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
	};
	const first = luminance(foreground);
	const second = luminance(background);
	return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
