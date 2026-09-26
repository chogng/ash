import { strict as assert } from "node:assert";
import { test } from "mocha";
import { createHash } from 'node:crypto';
import type { IExtensionApi } from '../../../../../platform/extensions/common/extensionApi.js';
import type { IServerEventApi } from '../../../../../platform/app-server/common/appServerApi.js';
import { WorkbenchThemesRegistry } from '../../../../common/theme.js';
import { editorBackground } from "../../../../../platform/theme/common/colors/editorColors.js";
import { ColorScheme } from "../../../../../platform/theme/common/theme.js";
import { createExtensionWorkbenchColorTheme, extensionWorkbenchThemeId, parseExtensionTheme } from "../../common/extensionTheme.js";
import { ExtensionColorThemeService } from '../../browser/extensionColorThemeService.js';

test("compiles a stable selectable Workbench theme from supported extension colors", () => {
	const id = extensionWorkbenchThemeId("vscode.theme-defaults", "Visual Studio Dark", 0);
	const definition = parseExtensionTheme({
		name: "Dark (Visual Studio)",
		colors: { "editor.background": "#1E1E1E", "unsupported.color": "#ffffff" },
		tokenColors: [],
	}, id, "vscode.theme-defaults", "%darkColorThemeLabel%", "vs-dark", "theme test");

	const theme = createExtensionWorkbenchColorTheme(definition);

	assert.equal(id, "extension-vscode-theme-defaults-visual-studio-dark");
	assert.equal(theme.label, "Dark (Visual Studio)");
	assert.equal(theme.colorScheme, ColorScheme.Dark);
	assert.equal(theme.getColorCss(editorBackground), "#1e1e1e");
});

test("rejects selectable extension themes without a supported UI scheme", () => {
	const definition = parseExtensionTheme({ colors: {}, tokenColors: [] }, "extension-ash-demo-one", "ash.demo", "Demo", undefined, "theme test");
	assert.throws(() => createExtensionWorkbenchColorTheme(definition), /uiTheme/);
});

test("rejects invalid token colors and font styles before a theme becomes active", () => {
	assert.throws(() => parseExtensionTheme({ tokenColors: [{ scope: "comment", settings: { foreground: "green" } }] }, "extension-ash-demo-one", "ash.demo", "Demo", "vs-dark", "theme test"), /Invalid color theme/);
	assert.throws(() => parseExtensionTheme({ tokenColors: [{ scope: "comment", settings: { fontStyle: "italic blink" } }] }, "extension-ash-demo-one", "ash.demo", "Demo", "vs-dark", "theme test"), /Invalid color theme/);
});

test('dedicated renderer loads extension themes and retains the last valid registration after a failed reload', async () => {
	const manifestJson = JSON.stringify({ name: 'example', publisher: 'ash', version: '1.0.0', contributes: { themes: [{ id: 'Example', label: 'Example', uiTheme: 'vs-dark', path: './themes/example.json' }] } });
	let generation = 1;
	let themeDocument = JSON.stringify({ colors: { 'editor.background': '#123456' } });
	const api: IExtensionApi = {
		list: async () => ({ generation, diagnostics: [], extensions: [{
			id: 'ash.example', name: 'example', publisher: 'ash', version: '1.0.0', displayName: 'Example', sourceKind: 'user',
			manifestJson, manifestSha256: `sha256:${createHash('sha256').update(manifestJson).digest('hex')}`,
			packageSha256: `sha256:${'a'.repeat(64)}`,
		}] }),
		readResource: async ({ generation: requestedGeneration, path }) => {
			assert.equal(requestedGeneration, generation);
			assert.equal(path, 'themes/example.json');
			return new TextEncoder().encode(themeDocument);
		},
	};
	let listener: Parameters<IServerEventApi['subscribe']>[0] | undefined;
	const events: IServerEventApi = { subscribe: callback => { listener = callback; return { dispose: () => { listener = undefined; } }; } };
	const themeId = 'extension-ash-example-example';
	{
		using service = new ExtensionColorThemeService(api, events);
		await service.start();
		assert.equal(WorkbenchThemesRegistry.getColorTheme(themeId)?.getColorCss(editorBackground), '#123456');
		generation++;
		themeDocument = '{ invalid';
		await assert.rejects(service.reload());
		assert.equal(WorkbenchThemesRegistry.getColorTheme(themeId)?.getColorCss(editorBackground), '#123456');
		generation++;
		themeDocument = JSON.stringify({ colors: { 'editor.background': '#654321' } });
		const changed = new Promise<void>(resolve => {
			const subscription = WorkbenchThemesRegistry.onDidChange(() => { subscription.dispose(); resolve(); });
		});
		listener?.({ method: 'plugin/changed', params: { revision: generation, activationGeneration: generation } });
		await changed;
		assert.equal(WorkbenchThemesRegistry.getColorTheme(themeId)?.getColorCss(editorBackground), '#654321');
	}
	assert.equal(WorkbenchThemesRegistry.getColorTheme(themeId), undefined);
	assert.equal(listener, undefined);
});
