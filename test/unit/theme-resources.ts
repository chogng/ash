import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import type { IExtensionApi, ExtensionResourceRequest } from '../../src/ash/platform/extensions/common/extensionApi.js';

const output = resolve(import.meta.dirname, '../../.build/desktop/test/src/ash');
const { ExtensionResourceLoaderService } = await import(pathToFileURL(resolve(output, 'platform/extensionResourceLoader/browser/extensionResourceLoaderService.js')).href);
const { normalizeExtensionCatalog } = await import(pathToFileURL(resolve(output, 'platform/extensions/common/extensionApi.js')).href);
const { decodeBase64 } = await import(pathToFileURL(resolve(output, 'base/common/buffer.js')).href);
const { ExtensionColorThemeService } = await import(pathToFileURL(resolve(output, 'workbench/services/extensions/browser/extensionColorThemeService.js')).href);
const bundle = JSON.parse(readFileSync(new URL('../../src/ash/platform/extensions/common/generated/browser.json', import.meta.url), 'utf8'));
const catalog = normalizeExtensionCatalog(bundle.catalog);
// Node reads the same packaged bytes from disk; UI windows fetch the generated asset.
const api: IExtensionApi = {
	list: async () => catalog,
	resources: new ExtensionResourceLoaderService(async (request: ExtensionResourceRequest) => decodeBase64(bundle.resources[request.extensionId][request.path]).buffer),
};
const themes = new ExtensionColorThemeService(api, {
	subscribe: () => ({ dispose() { } }),
});
await themes.start();
process.once('exit', () => themes.dispose());
