import { strict as assert } from "node:assert";
import { test } from "mocha";
import { createColorTheme } from "../../../platform/theme/common/colorTheme.js";
import { ColorScheme } from "../../../platform/theme/common/theme.js";
import { WorkbenchThemeRegistry } from "../../common/theme.js";

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
