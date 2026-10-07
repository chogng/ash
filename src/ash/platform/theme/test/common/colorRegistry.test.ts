import { strict as assert } from "node:assert";
import { test } from "mocha";
import { ColorRegistry } from "../../common/colorRegistry.js";
import { colorCssVariable, transparent } from "../../common/colorUtils.js";
import { ColorScheme } from "../../common/theme.js";

const metadata = { description: "Test token.", owner: "test" };

test('color CSS names preserve identifier casing and replace every dot', () => {
	const identifiers = ['focusBorder', 'focus.border', 'editorCursor.foreground', 'editorSuggestWidget.selectedForeground', 'extensionWidget.button.hoverBackground'];
	assert.deepEqual(identifiers.map(colorCssVariable), [
		'--ash-focusBorder',
		'--ash-focus-border',
		'--ash-editorCursor-foreground',
		'--ash-editorSuggestWidget-selectedForeground',
		'--ash-extensionWidget-button-hoverBackground',
	]);
});

test('color defaults resolve each theme type and preserve high contrast overrides', () => {
	using registry = new ColorRegistry();
	registry.registerColor('test.scheme', { dark: '#112233', light: '#445566', hcDark: '#778899', hcLight: '#aabbcc' }, metadata);
	const schemes = [ColorScheme.Dark, ColorScheme.Light, ColorScheme.HighContrastDark, ColorScheme.HighContrastLight];
	assert.deepEqual(schemes.map(scheme => ({ type: scheme, color: registry.resolve(scheme)[0]?.value?.toString() })), [
		{ type: 'dark', color: '#112233' },
		{ type: 'light', color: '#445566' },
		{ type: 'hcDark', color: '#778899' },
		{ type: 'hcLight', color: '#aabbcc' },
	]);
	assert.equal(registry.resolve(ColorScheme.HighContrastLight, { 'test.scheme': '#abcdef' })[0]?.value?.toString(), '#abcdef');
});

test("ColorRegistry resolves aliases and transforms deterministically", () => {
	using registry = new ColorRegistry();
	registry.registerColor("surface.background", { dark: "#000000", light: "#ffffff", hcDark: "#000000", hcLight: "#ffffff" }, metadata);
	registry.registerColor("surface.overlay", { dark: transparent("surface.background", 0.5), light: transparent("surface.background", 0.25), hcDark: null, hcLight: null }, { ...metadata, needsTransparency: true });

	const dark = registry.resolve(ColorScheme.Dark);
	assert.equal(dark[0]?.value?.toString(), "#000000");
	assert.equal(dark[1]?.value?.toString(), 'rgba(0, 0, 0, 0.5)');
	assert.equal(registry.resolve(ColorScheme.Light)[1]?.value?.toString(), 'rgba(255, 255, 255, 0.25)');
	assert.equal(registry.resolve(ColorScheme.HighContrastDark)[1]?.value, null);
});

test("ColorRegistry rejects duplicates, cycles, unknown references, and unknown overrides", () => {
	using duplicate = new ColorRegistry();
	duplicate.registerColor("test.color", { dark: "#000000", light: "#ffffff", hcDark: "#000000", hcLight: "#ffffff" }, metadata);
	assert.throws(() => duplicate.registerColor("test.color", { dark: "#000000", light: "#ffffff", hcDark: "#000000", hcLight: "#ffffff" }, metadata), /already registered/);

	using cyclic = new ColorRegistry();
	cyclic.registerColor("cycle.first", { dark: "cycle.second", light: "#ffffff", hcDark: "#000000", hcLight: "#ffffff" }, metadata);
	cyclic.registerColor("cycle.second", { dark: "cycle.first", light: "#ffffff", hcDark: "#000000", hcLight: "#ffffff" }, metadata);
	assert.throws(() => cyclic.resolve(ColorScheme.Dark), /cycle\.first -> cycle\.second -> cycle\.first/);

	using unknown = new ColorRegistry();
	unknown.registerColor("test.color", { dark: "missing.color", light: "#ffffff", hcDark: "#000000", hcLight: "#ffffff" }, metadata);
	assert.throws(() => unknown.resolve(ColorScheme.Dark), /Unknown color token reference/);
	assert.throws(() => unknown.resolve(ColorScheme.Light, { "missing.override": "#000000" }), /Unknown color token override/);
});

test("color contributions publish a new catalog without changing earlier snapshots", () => {
	using colors = new ColorRegistry();
	const before = colors.getColors();
	const changes: string[][] = [];
	using listener = colors.onDidChange(() => changes.push(colors.getColors().map(entry => entry.id)));
	colors.registerColor("late.color", { dark: "#000000", light: "#ffffff", hcDark: "#000000", hcLight: "#ffffff" }, metadata);
	assert.deepEqual({ before, changes, resolved: colors.resolve(ColorScheme.Light)[0]?.value?.toString() }, {
		before: [], changes: [["late.color"]], resolved: "#ffffff",
	});
	assert.equal(colors.getColors(), colors.getColors());
	assert.throws(() => colors.registerColor("late.color", { dark: "#000000", light: "#ffffff", hcDark: "#000000", hcLight: "#ffffff" }, metadata), /already registered/);
	assert.equal(changes.length, 1);
});
