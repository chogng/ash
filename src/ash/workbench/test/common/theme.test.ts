import { loadColorThemeDocument } from '../../services/themes/common/colorThemeData.js';
import { strict as assert } from "node:assert";
import { test } from "mocha";
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from "../../../platform/theme/common/colorTheme.js";
import { ColorScheme } from "../../../platform/theme/common/theme.js";
import { ColorRegistry, Colors } from '../../../platform/theme/common/colorRegistry.js';
import { formatNlsMessage, resetNlsResolver, setNlsResolver } from '../../../nls.js';
import { builtinLanguagePackCatalogs } from '../../services/localization/common/localizationCatalogs.js';
import { WorkbenchThemeRegistry, WorkbenchThemesRegistry, getWorkbenchColorTheme, resolveWorkbenchColorTheme } from "../../common/theme.js";
test('Activity Bar badge color descriptions appear in Chinese in the theme color catalog', () => {
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	try {
		setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
		using registry = new ColorRegistry();
		for (const id of ['activityBarBadge.background', 'activityBarBadge.foreground']) {
			const color = Colors.getColors().find(color => color.id === id)!;
			registry.registerColor(id, color.defaults, color);
		}
		assert.deepEqual(registry.getColors().map(color => color.description), ['活动栏通知徽章的背景色。', '活动栏通知徽章的文字颜色。']);
	} finally {
		resetNlsResolver();
	}
});

test('contributed Ash themes resolve authored window colors and included syntax resources', async () => {
	for (const id of ['ash-dark', 'ash-light', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
		const document = JSON.parse(await readFile(resolve(`extensions/theme-defaults/themes/${id}.json`), 'utf8'));
		const theme = getWorkbenchColorTheme(id);
		assert.equal(theme.label, document.name);
		for (const [color, value] of Object.entries(document.colors)) {
			assert.equal(theme.getColorCss(color), value, `${id}: ${color}`);
		}
	}
	assert.equal(resolveWorkbenchColorTheme('system', true), getWorkbenchColorTheme('ash-dark'));
	assert.equal(resolveWorkbenchColorTheme('system', false), getWorkbenchColorTheme('ash-light'));
});

test('built-in high contrast themes keep common foreground and background pairs readable', () => {
	assert.deepEqual(WorkbenchThemesRegistry.getColorThemes().filter(theme => theme.id.startsWith('ash-high-contrast-')).map(theme => theme.id), [
		highContrastLightColorTheme.id,
		highContrastDarkColorTheme.id,
	]);
	const pairs = [
		['foreground', 'workbench.background'],
		['activityBarBadge.foreground', 'activityBarBadge.background'],
		['editor.foreground', 'editor.background'],
		['input.foreground', 'input.background'],
		['button.foreground', 'button.background'],
		['button.primaryForeground', 'button.primaryBackground'],
		['button.primaryForeground', 'button.primaryHoverBackground'],
		['list.activeSelectionForeground', 'list.activeSelectionBackground'],
		['foreground', 'list.inactiveSelectionBackground'],
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
	for (const theme of [getWorkbenchColorTheme(highContrastDarkColorTheme.id), getWorkbenchColorTheme(highContrastLightColorTheme.id)]) {
		for (const [foreground, background] of pairs) {
			const text = theme.getColor(foreground);
			const surface = theme.getColor(background);
			assert.ok(text && surface);
			assert.ok(contrastRatio(text.rgba, surface.rgba) >= 7, `${theme.id}: ${foreground} on ${background}`);
		}
	}
});

test('built-in syntax rules use the theme-defaults extension resources', async () => {
	for (const [id, file] of [
		['ash-dark', 'dark_vs'],
		['ash-light', 'light_vs'],
		['ash-high-contrast-dark', 'hc_black'],
		['ash-high-contrast-light', 'hc_light'],
	] as const) {
		const document = await loadColorThemeDocument(`themes/${file}.json`, async resource => JSON.parse(await readFile(resolve('extensions/theme-defaults', resource), 'utf8')));
		assert.ok(Array.isArray(document.tokenColors));
		const actual = getWorkbenchColorTheme(id).tokenColors!.map(rule => ({ scopes: rule.scopes, settings: rule.settings }));
		const expected = document.tokenColors.map((rule: { scope?: string | string[]; settings: object; }) => ({ scopes: typeof rule.scope === 'string' ? [rule.scope] : rule.scope ?? [], settings: rule.settings }));
		assert.deepEqual(actual, expected, id);
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

function contrastRatio(foreground: { r: number; g: number; b: number; }, background: { r: number; g: number; b: number; }): number {
	const luminance = (color: { r: number; g: number; b: number; }): number => {
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
