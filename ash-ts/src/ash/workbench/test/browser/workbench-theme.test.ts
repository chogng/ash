import assert from "node:assert/strict";
import { test } from "mocha";
import { createColorTheme, darkColorTheme } from "../../../platform/theme/common/colorTheme.js";
import { ThemeService } from "../../../platform/theme/common/themeService.js";
import { ColorScheme } from "../../../platform/theme/common/theme.js";
import { WorkbenchThemeController } from "../../../workbench/browser/theme.js";
import { WorkbenchConfiguration } from "../../../workbench/common/configuration.js";
import { WorkbenchThemesRegistry } from "../../../workbench/common/theme.js";
import { WorkbenchConfigurationService } from "../../../workbench/services/configuration/browser/configurationService.js";

test("system theme follows the OS while explicit themes remain stable", async () => {
	using configuration = new WorkbenchConfigurationService();
	using themeService = new ThemeService(darkColorTheme);
	const systemTheme = new TestMediaQueryList(false);
	using controller = new WorkbenchThemeController(
		configuration,
		themeService,
		{
			matchMedia: (query: string) => {
				assert.equal(query, "(prefers-color-scheme: dark)");
				return systemTheme as unknown as MediaQueryList;
			},
		} as unknown as Window,
	);

	assert.equal(themeService.getColorTheme().id, "ash-light");
	systemTheme.setMatches(true);
	assert.equal(themeService.getColorTheme().id, "ash-dark");

	await configuration.updateValue(
		WorkbenchConfiguration.colorTheme,
		"ash-light",
	);
	assert.equal(themeService.getColorTheme().id, "ash-light");
	systemTheme.setMatches(false);
	systemTheme.setMatches(true);
	assert.equal(themeService.getColorTheme().id, "ash-light");

	await configuration.updateValue(
		WorkbenchConfiguration.colorTheme,
		"system",
	);
	assert.equal(themeService.getColorTheme().id, "ash-dark");
});

test("a persisted dynamic theme falls back until its extension contribution is available", async () => {
	using configuration = new WorkbenchConfigurationService();
	await configuration.updateValue(WorkbenchConfiguration.colorTheme, "extension-demo-dark");
	using themeService = new ThemeService(darkColorTheme);
	const systemTheme = new TestMediaQueryList(false);
	using controller = new WorkbenchThemeController(configuration, themeService, { matchMedia: () => systemTheme as unknown as MediaQueryList } as unknown as Window);

	assert.equal(themeService.getColorTheme().id, "ash-light");
	using registration = WorkbenchThemesRegistry.registerColorTheme(createColorTheme({ id: "extension-demo-dark", label: "Demo Dark", colorScheme: ColorScheme.Dark }));
	controller.refresh();
	assert.equal(themeService.getColorTheme().id, "extension-demo-dark");
});

class TestMediaQueryList {
	private readonly listeners = new Set<() => void>();

	constructor(public matches: boolean) {}

	addEventListener(type: string, listener: () => void): void {
		if (type === "change") this.listeners.add(listener);
	}

	removeEventListener(type: string, listener: () => void): void {
		if (type === "change") this.listeners.delete(listener);
	}

	setMatches(matches: boolean): void {
		if (matches === this.matches) return;
		this.matches = matches;
		for (const listener of this.listeners) listener();
	}
}
