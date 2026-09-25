import { strict as assert } from "node:assert";
import { test } from "mocha";
import { ColorRegistry } from "../../common/colorRegistry.js";
import { transparent } from "../../common/colorUtils.js";
import { ColorScheme } from "../../common/theme.js";

const metadata = { description: "Test token.", owner: "test" };

test("ColorRegistry resolves aliases and transforms deterministically", () => {
	using registry = new ColorRegistry();
	registry.registerColor("surface.background", { dark: "#000000", light: "#ffffff" }, metadata);
	registry.registerColor("surface.overlay", { dark: transparent("surface.background", 0.5), light: transparent("surface.background", 0.25) }, { ...metadata, needsTransparency: true });

	const dark = registry.resolve(ColorScheme.Dark);
	assert.equal(dark[0]?.value?.toString(), "#000000");
	assert.equal(dark[1]?.value?.toString(), 'rgba(0, 0, 0, 0.5)');
	assert.equal(registry.resolve(ColorScheme.Light)[1]?.value?.toString(), 'rgba(255, 255, 255, 0.25)');
});

test("ColorRegistry rejects duplicates, cycles, unknown references, and unknown overrides", () => {
	using duplicate = new ColorRegistry();
	duplicate.registerColor("test.color", { dark: "#000000", light: "#ffffff" }, metadata);
	assert.throws(() => duplicate.registerColor("test.color", { dark: "#000000", light: "#ffffff" }, metadata), /already registered/);

	using cyclic = new ColorRegistry();
	cyclic.registerColor("cycle.first", { dark: "cycle.second", light: "#ffffff" }, metadata);
	cyclic.registerColor("cycle.second", { dark: "cycle.first", light: "#ffffff" }, metadata);
	assert.throws(() => cyclic.resolve(ColorScheme.Dark), /cycle\.first -> cycle\.second -> cycle\.first/);

	using unknown = new ColorRegistry();
	unknown.registerColor("test.color", { dark: "missing.color", light: "#ffffff" }, metadata);
	assert.throws(() => unknown.resolve(ColorScheme.Dark), /Unknown color token reference/);
	assert.throws(() => unknown.resolve(ColorScheme.Light, { "missing.override": "#000000" }), /Unknown color token override/);
});

test("color contributions publish a new catalog without changing earlier snapshots", () => {
	using colors = new ColorRegistry();
	const before = colors.getColors();
	const changes: string[][] = [];
	using listener = colors.onDidChange(() => changes.push(colors.getColors().map(entry => entry.id)));
	colors.registerColor("late.color", { dark: "#000000", light: "#ffffff" }, metadata);
	assert.deepEqual({ before, changes, resolved: colors.resolve(ColorScheme.Light)[0]?.value?.toString() }, {
		before: [], changes: [["late.color"]], resolved: "#ffffff",
	});
	assert.equal(colors.getColors(), colors.getColors());
	assert.throws(() => colors.registerColor("late.color", { dark: "#000000", light: "#ffffff" }, metadata), /already registered/);
	assert.equal(changes.length, 1);
});
