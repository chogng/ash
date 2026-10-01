import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const output = resolve(import.meta.dirname, '../../../.build/app-ts/test/src/ash');
const { createDisconnectedExtensionApi } = await import(pathToFileURL(resolve(output, 'platform/extensions/browser/extensionApi.js')).href);
const { ExtensionColorThemeService } = await import(pathToFileURL(resolve(output, 'workbench/services/extensions/browser/extensionColorThemeService.js')).href);
// Test processes initialize the bundled contributions through the same resource API as the UI.
const themes = new ExtensionColorThemeService(createDisconnectedExtensionApi((operation: string) => { throw new Error(operation); }), {
	subscribe: () => ({ dispose() {} }),
});
await themes.start();
process.once('exit', () => themes.dispose());
