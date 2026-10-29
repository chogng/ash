import { createEmptyTestLanguagePacks } from '../../../src/ash/workbench/services/localization/test/common/localizationTestUtils.js';
import type { IAdapterManager } from '../../../src/ash/workbench/contrib/debug/common/debug.js';
import { ExtensionResourceLoaderService } from '../../../src/ash/platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';
import javascript from '../../../extensions/javascript/package.json' with { type: 'json' };
import typescript from '../../../extensions/typescript-basics/package.json' with { type: 'json' };
import json from '../../../extensions/json/package.json' with { type: 'json' };
import rust from '../../../extensions/rust/package.json' with { type: 'json' };
import shellscript from '../../../extensions/shellscript/package.json' with { type: 'json' };
import bazel from '../../../extensions/bazel/package.json' with { type: 'json' };
import git from '../../../extensions/git-base/package.json' with { type: 'json' };
import ini from '../../../extensions/ini/package.json' with { type: 'json' };
import diff from '../../../extensions/diff/package.json' with { type: 'json' };
import markdown from '../../../extensions/markdown-basics/package.json' with { type: 'json' };
import cpp from '../../../extensions/cpp/package.json' with { type: 'json' };
import java from '../../../extensions/java/package.json' with { type: 'json' };
import csharp from '../../../extensions/csharp/package.json' with { type: 'json' };
import powershell from '../../../extensions/powershell/package.json' with { type: 'json' };
import bat from '../../../extensions/bat/package.json' with { type: 'json' };
import docker from '../../../extensions/docker/package.json' with { type: 'json' };
import make from '../../../extensions/make/package.json' with { type: 'json' };
import dotenv from '../../../extensions/dotenv/package.json' with { type: 'json' };
import yaml from '../../../extensions/yaml/package.json' with { type: 'json' };
import lua from '../../../extensions/lua/package.json' with { type: 'json' };
import ruby from '../../../extensions/ruby/package.json' with { type: 'json' };
import php from '../../../extensions/php/package.json' with { type: 'json' };
import swift from '../../../extensions/swift/package.json' with { type: 'json' };
import dart from '../../../extensions/dart/package.json' with { type: 'json' };
import log from '../../../extensions/log/package.json' with { type: 'json' };
import r from '../../../extensions/r/package.json' with { type: 'json' };
import julia from '../../../extensions/julia/package.json' with { type: 'json' };
import clojure from '../../../extensions/clojure/package.json' with { type: 'json' };
import groovy from '../../../extensions/groovy/package.json' with { type: 'json' };
import coffeescript from '../../../extensions/coffeescript/package.json' with { type: 'json' };
import perl from '../../../extensions/perl/package.json' with { type: 'json' };
import type { ExtensionDescriptor } from '../../../src/ash/platform/extensions/common/extensionApi.js';
import { AppServerExtensionService, type AppServerExtensionServiceOptions } from '../../../src/ash/workbench/services/extensions/browser/appServerExtensionService.js';

const resourceUrls = import.meta.glob<string>(
	[
		'../../../extensions/{javascript,typescript-basics,json,rust,shellscript,bazel,ini,diff,markdown-basics}/*language-configuration.json',
		'../../../extensions/git-base/languages/*language-configuration.json',
		'../../../extensions/{javascript,typescript-basics,json,rust,shellscript,bazel,markdown-basics}/snippets/*',
		'../../../extensions/{cpp,java,csharp,powershell,bat,docker,make,dotenv,yaml}/*language-configuration.json',
		'../../../extensions/{cpp,java,csharp,powershell,bat,docker,make,dotenv}/snippets/*',
		'../../../extensions/{lua,ruby,php,swift,dart,log}/*language-configuration.json',
		'../../../extensions/{r,julia,clojure,groovy,coffeescript,perl}/*language-configuration.json',
		'../../../extensions/{r,julia,clojure,groovy,coffeescript,perl}/snippets/*',
		'../../../extensions/{r,julia,clojure,groovy,coffeescript,perl}/package.nls*.json',
		'../../../extensions/{lua,ruby,php,swift,dart,json}/snippets/*',
		'../../../extensions/{lua,ruby,php,swift,dart,log,json}/package.nls*.json',
	],
	{ eager: true, query: '?url', import: 'default' },
);

export async function createLanguageExtensions(options: Omit<AppServerExtensionServiceOptions, 'api' | 'eventApi'>, adapters: IAdapterManager): Promise<AppServerExtensionService> {
	const directories = new Map<string, string>();
	const descriptors: ExtensionDescriptor[] = [];
	const manifests = [
		['javascript', javascript],
		['typescript-basics', typescript],
		['json', json],
		['rust', rust],
		['shellscript', shellscript],
		['bazel', bazel],
		['git-base', git],
		['ini', ini],
		['diff', diff],
		['markdown-basics', markdown],
		['cpp', cpp],
		['java', java],
		['csharp', csharp],
		['powershell', powershell],
		['bat', bat],
		['docker', docker],
		['make', make],
		['dotenv', dotenv],
		['yaml', yaml],
		['lua', lua],
		['ruby', ruby],
		['php', php],
		['swift', swift],
		['dart', dart],
		['log', log],
		['perl', perl],
		['coffeescript', coffeescript],
		['groovy', groovy],
		['clojure', clojure],
		['julia', julia],
		['r', r],
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
	return new AppServerExtensionService(
		{
			...options,
			api: {
				list: async () => ({ generation: 1, diagnostics: [], extensions: descriptors }),
				resources: new ExtensionResourceLoaderService(async request => {
					const path = request.path.replace(/^\.\//u, '');
					const url = resourceUrls[`../../../extensions/${directories.get(request.extensionId)}/${path}`];
					if (!url) {
						throw new Error(`Missing extension fixture: ${request.extensionId}/${path}`);
					}
					const response = await fetch(url);
					if (!response.ok) {
						throw new Error(`Extension fixture failed: ${path}`);
					}
					return new Uint8Array(await response.arrayBuffer());
				}),
			},
		},
		createEmptyTestLanguagePacks(),
		adapters,
	);
}
