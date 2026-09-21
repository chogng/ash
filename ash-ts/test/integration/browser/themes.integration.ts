import manifest from '../../../../extensions/theme-seti/package.json' with { type: 'json' };
import themeUrl from '../../../../extensions/theme-seti/icons/vs-seti-icon-theme.json?url';
import fontUrl from '../../../../extensions/theme-seti/icons/seti.woff?url';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { ServiceContainer } from '../../../src/ash/platform/instantiation/common/instantiation.js';
import { WorkbenchConfiguration } from '../../../src/ash/workbench/common/configuration.js';
import { WorkbenchConfigurationService } from '../../../src/ash/workbench/services/configuration/browser/configurationService.js';
import { AppServerExtensionService } from '../../../src/ash/workbench/services/extensions/browser/appServerExtensionService.js';
import { WorkbenchThemeService } from '../../../src/ash/workbench/services/themes/browser/workbenchThemeService.js';
import { TextMateGrammarService } from '../../../src/ash/workbench/services/textMate/common/textMateGrammarService.js';
import type { ITextMateService } from '../../../src/ash/workbench/services/textMate/common/textMateService.js';
import { createTextMateSyntaxWorkerFactory } from '../../../src/ash/workbench/services/textMate/browser/textMateSyntaxWorkerClient.js';
import { TextMateGrammarCatalogModel } from '../../../src/ash/workbench/services/textMate/common/textMateGrammarCatalog.js';
import { TextMateScopeThemeModel } from '../../../src/ash/workbench/services/textMate/common/textMateScopeTheme.js';
import { SyntaxProviderRegistry } from '../../../src/ash/editor/common/languages/syntax/syntaxProviders.js';
import { SyntaxService } from '../../../src/ash/editor/common/languages/syntax/syntaxService.js';
import { TextModel } from '../../../src/ash/editor/common/model/textModel.js';

declare global {
	interface Window {
		tokenizeInTextMateWorker(): Promise<readonly { type: string; modifiers: readonly string[] }[]>;
	}
}

window.tokenizeInTextMateWorker = async () => {
	using catalogs = new TextMateGrammarCatalogModel({
		revision: 1,
		grammars: [{
			scopeName: 'source.demo',
			languageId: 'demo',
			injectTo: [],
			content: JSON.stringify({ scopeName: 'source.demo', patterns: [{ match: '\\bif\\b', name: 'keyword.control.demo' }] }),
		}],
	});
	using scopeTheme = new TextMateScopeThemeModel();
	using providers = new SyntaxProviderRegistry();
	using model = new TextModel('if');
	using syntax = new SyntaxService(model, providers, { workerFactory: createTextMateSyntaxWorkerFactory(catalogs, scopeTheme) });
	const results: { type: string; modifiers: readonly string[] }[] = [];
	const capture = async (): Promise<void> => {
		await syntax.requestTokens('demo');
		const token = syntax.tokens.result?.value.tokens[0];
		if (!token) {
			throw new Error('TextMate Worker did not tokenize the registered grammar');
		}
		results.push({ type: token.tokenType, modifiers: token.modifiers });
	};
	await capture();
	scopeTheme.replace({ revision: 1, rules: [{ selector: 'keyword.control.demo', tokenType: 'keyword', modifiers: ['declaration'] }] });
	await capture();
	catalogs.replace({
		revision: 2,
		grammars: [{ ...catalogs.currentCatalog.grammars[0]!, content: JSON.stringify({ scopeName: 'source.demo', patterns: [{ match: '\\bif\\b', name: 'string.quoted.demo' }] }) }],
	});
	await capture();
	syntax.restartWorker();
	await capture();
	return results;
};

const resources = new DisposableStore();
const configuration = resources.add(new WorkbenchConfigurationService());
await configuration.updateValue(WorkbenchConfiguration.colorTheme, 'ash-dark');
const services = resources.add(new ServiceContainer());
services.registerInstance(IConfigurationService, configuration);
const themes = resources.add(services.createInstance(WorkbenchThemeService, document.querySelector<HTMLElement>('#root')!));
themes.initialize();
const render = (): void => themes.renderFileIcon(URI.file('/workspace/main.ts'), document.querySelector<HTMLElement>('#icon')!);
resources.add(themes.onDidFileIconThemeChange(render));
const manifestJson = JSON.stringify(manifest);
const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(manifestJson));
const hash = 'sha256:' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
const urls: Record<string, string> = { 'icons/vs-seti-icon-theme.json': themeUrl, 'icons/seti.woff': fontUrl };
const grammars = resources.add(new TextMateGrammarService());
const extensions = resources.add(new AppServerExtensionService({
	api: {
		list: async () => ({ generation: 1, diagnostics: [], extensions: [{
			id: 'ash.theme-seti', name: manifest.name, publisher: manifest.publisher, version: manifest.version,
			displayName: manifest.displayName, sourceKind: 'builtIn', manifestJson, manifestSha256: hash, packageSha256: hash,
		}] }),
		readResource: async request => {
			if (!urls[request.path]) { throw new Error('Unexpected icon resource'); }
			const response = await fetch(urls[request.path]!);
			if (!response.ok) { throw new Error('Icon resource failed'); }
			return new Uint8Array(await response.arrayBuffer());
		},
	},
	textMateService: { grammars } as unknown as ITextMateService,
}));
await extensions.start();
render();
document.querySelector('#none')!.addEventListener('click', () => { void configuration.updateValue(WorkbenchConfiguration.iconTheme, null); });
document.querySelector('#seti')!.addEventListener('click', () => { void configuration.updateValue(WorkbenchConfiguration.iconTheme, 'vs-seti'); });
document.querySelector('#light')!.addEventListener('click', () => { void configuration.updateValue(WorkbenchConfiguration.colorTheme, 'ash-light'); });
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
document.body.dataset.ready = 'true';
