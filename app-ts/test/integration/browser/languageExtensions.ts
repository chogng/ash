import javascript from '../../../../extensions/javascript/package.json' with { type: 'json' };
import typescript from '../../../../extensions/typescript-basics/package.json' with { type: 'json' };
import json from '../../../../extensions/json/package.json' with { type: 'json' };
import rust from '../../../../extensions/rust/package.json' with { type: 'json' };
import shellscript from '../../../../extensions/shellscript/package.json' with { type: 'json' };
import type { ExtensionDescriptor } from '../../../src/ash/platform/extensions/common/extensionApi.js';
import { AppServerExtensionService, type AppServerExtensionServiceOptions } from '../../../src/ash/workbench/services/extensions/browser/appServerExtensionService.js';

const resourceUrls = import.meta.glob<string>([
	'../../../../extensions/{javascript,typescript-basics,json,rust,shellscript}/syntaxes/*',
	'../../../../extensions/{javascript,typescript-basics,json,rust,shellscript}/*language-configuration.json',
	'../../../../extensions/{javascript,typescript-basics,json,rust,shellscript}/snippets/*',
], { eager: true, query: '?url', import: 'default' });

export async function createLanguageExtensions(options: Omit<AppServerExtensionServiceOptions, 'api' | 'eventApi'>): Promise<AppServerExtensionService> {
	const directories = new Map<string, string>();
	const descriptors: ExtensionDescriptor[] = [];
	const manifests = [
		['javascript', javascript],
		['typescript-basics', typescript],
		['json', json],
		['rust', rust],
		['shellscript', shellscript],
	] as const;
	for (const [directory, manifest] of manifests) {
		const manifestJson = JSON.stringify(manifest);
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(manifestJson));
		const hash = 'sha256:' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
		const id = `${manifest.publisher}.${manifest.name}`;
		directories.set(id, directory);
		descriptors.push({
			id,
			name: manifest.name,
			publisher: manifest.publisher,
			version: manifest.version,
			displayName: manifest.displayName,
			sourceKind: 'builtIn',
			manifestJson,
			manifestSha256: hash,
			packageSha256: hash,
		});
	}
	return new AppServerExtensionService({
		...options,
		api: {
			list: async () => ({ generation: 1, diagnostics: [], extensions: descriptors }),
			readResource: async request => {
				const path = request.path.replace(/^\.\//u, '');
				const url = resourceUrls[`../../../../extensions/${directories.get(request.extensionId)}/${path}`];
				if (!url) {
					throw new Error(`Missing extension fixture: ${request.extensionId}/${path}`);
				}
				const response = await fetch(url);
				if (!response.ok) {
					throw new Error(`Extension fixture failed: ${path}`);
				}
				return new Uint8Array(await response.arrayBuffer());
			},
		},
	});
}
