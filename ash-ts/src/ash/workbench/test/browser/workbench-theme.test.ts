import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Disposable, DisposableTracker, installDisposableTracker, toDisposable } from '../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { ServiceContainer } from '../../../platform/instantiation/common/instantiation.js';
import { createColorTheme, highContrastDarkColorTheme } from '../../../platform/theme/common/colorTheme.js';
import { ColorScheme } from '../../../platform/theme/common/theme.js';
import { WorkbenchConfiguration } from '../../common/configuration.js';
import { WorkbenchThemesRegistry } from '../../common/theme.js';
import { WorkbenchConfigurationService } from '../../services/configuration/browser/configurationService.js';
import { WorkbenchThemeService } from '../../services/themes/browser/workbenchThemeService.js';

class ThemeWindow extends Disposable {
	public readonly browser = new JSDOM('<!doctype html><body><main></main></body>');
	public readonly root = this.browser.window.document.querySelector('main')!;
	public readonly systemTheme = new TestMediaQueryList(false);
	public readonly configuration = this._register(new WorkbenchConfigurationService());
	public readonly services = this._register(new ServiceContainer());
	public readonly themes: WorkbenchThemeService;

	constructor() {
		super();
		this._register(toDisposable(() => this.browser.window.close()));
		Object.defineProperty(this.browser.window, 'matchMedia', { value: (query: string) => {
			assert.equal(query, '(prefers-color-scheme: dark)');
			return this.systemTheme;
		} });
		this.services.registerInstance(IConfigurationService, this.configuration);
		this.themes = this._register(this.services.createInstance(WorkbenchThemeService, this.root));
		this.themes.initialize();
	}
}

test('system theme follows the OS while explicit themes remain stable', async () => {
	using window = new ThemeWindow();
	const { configuration, themes, systemTheme, root } = window;
	assert.equal(themes.getColorTheme().id, 'ash-light');
	systemTheme.setMatches(true);
	assert.equal(root.getAttribute('data-color-theme'), 'ash-dark');
	await configuration.updateValue(WorkbenchConfiguration.colorTheme, 'ash-light');
	systemTheme.setMatches(false);
	systemTheme.setMatches(true);
	assert.equal(root.getAttribute('data-color-theme'), 'ash-light');
	await configuration.updateValue(WorkbenchConfiguration.colorTheme, 'system');
	assert.equal(root.getAttribute('data-color-theme'), 'ash-dark');
});

test('dynamic theme registration and replacement update the active window without a refresh caller', async () => {
	using window = new ThemeWindow();
	const { configuration, themes, root } = window;
	await configuration.updateValue(WorkbenchConfiguration.colorTheme, 'extension-demo-dark');
	assert.equal(themes.getColorTheme().id, 'ash-light');
	using registration = WorkbenchThemesRegistry.registerColorThemes([
		createColorTheme({ id: 'extension-demo-dark', label: 'Demo Dark', colorScheme: ColorScheme.Dark }),
	]);
	assert.equal(root.getAttribute('data-color-theme'), 'extension-demo-dark');
	let changes = 0;
	using listener = themes.onDidColorThemeChange(() => changes++);
	registration.replace([createColorTheme({
		id: 'extension-demo-dark', label: 'Updated', colorScheme: ColorScheme.HighContrastDark,
		colorOverrides: { 'editor.background': '#123456' },
	})]);
	assert.deepEqual([themes.getColorTheme().label, root.getAttribute('data-color-scheme'), root.style.getPropertyValue('--ash-editor-background'), changes],
		['Updated', ColorScheme.HighContrastDark, '#123456', 1]);
	registration.dispose();
	assert.equal(root.getAttribute('data-color-theme'), 'ash-light');
	assert.equal(configuration.getValue(WorkbenchConfiguration.colorTheme), 'extension-demo-dark');
});

test('unrelated registrations do not notify colors or file icons and disposal releases window resources', async () => {
	const tracker = new DisposableTracker();
	using tracking = installDisposableTracker(tracker);
	{
		using window = new ThemeWindow();
		const { themes, root, configuration, systemTheme } = window;
		let colors = 0;
		let icons = 0;
		using colorListener = themes.onDidColorThemeChange(() => colors++);
		using iconListener = themes.onDidFileIconThemeChange(() => icons++);
		using registration = WorkbenchThemesRegistry.registerColorTheme(highContrastDarkColorTheme);
		assert.deepEqual([colors, icons], [0, 0]);
		await configuration.updateValue(WorkbenchConfiguration.colorTheme, highContrastDarkColorTheme.id);
		assert.deepEqual([colors, icons, root.getAttribute('data-color-scheme')], [1, 1, ColorScheme.HighContrastDark]);
		themes.dispose();
		assert.equal(systemTheme.listenerCount, 0);
		assert.equal(root.getAttribute('data-color-theme'), null);
		assert.equal(root.style.getPropertyValue('--ash-editor-background'), '');
		systemTheme.setMatches(true);
		await configuration.updateValue(WorkbenchConfiguration.colorTheme, 'ash-dark');
		assert.deepEqual([colors, icons], [1, 1]);
	}
	tracker.assertNoLeaks();
});

test('workbench theme creation rejects a missing configuration registration', () => {
	using services = new ServiceContainer();
	assert.throws(() => services.createInstance(WorkbenchThemeService, {}), /configurationService/);
});

class TestMediaQueryList {
	private readonly listeners = new Set<() => void>();
	constructor(public matches: boolean) {}
	public get listenerCount(): number { return this.listeners.size; }
	public addEventListener(type: string, listener: () => void): void {
		if (type === 'change') { this.listeners.add(listener); }
	}
	public removeEventListener(type: string, listener: () => void): void {
		if (type === 'change') { this.listeners.delete(listener); }
	}
	public setMatches(matches: boolean): void {
		if (matches === this.matches) { return; }
		this.matches = matches;
		for (const listener of this.listeners) { listener(); }
	}
}
