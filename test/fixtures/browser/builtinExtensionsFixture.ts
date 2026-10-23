import { decodeBase64 } from '../../../src/ash/base/common/buffer.js';
import { normalizeExtensionCatalog, type IExtensionApi } from '../../../src/ash/platform/extensions/common/extensionApi.js';
import { ExtensionResourceLoaderService } from '../../../src/ash/platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';

/** Test pages inject a prepared package fixture at the Rust adapter boundary. */
export function createBuiltinExtensionFixture(): IExtensionApi {
	const loading = fetch(new URL('../../../.build/builtin/fixture.json', import.meta.url)).then(async response => {
		if (!response.ok) throw new Error('Builtin extension fixture is unavailable');
		const fixture = await response.json();
		return { catalog: normalizeExtensionCatalog(fixture.catalog), resources: fixture.resources as Record<string, Record<string, string>> };
	});
	return {
		list: async () => (await loading).catalog,
		resources: new ExtensionResourceLoaderService(async request => {
			const fixture = await loading;
			const value = fixture.resources[request.extensionId]?.[request.path];
			if (request.generation !== fixture.catalog.generation || value === undefined) throw new Error('Resource is not in the injected extension fixture');
			return decodeBase64(value).buffer;
		}),
	};
}
