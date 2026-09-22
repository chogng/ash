import javascript from '../../../../extensions/javascript/package.json' with { type: 'json' };
import typescript from '../../../../extensions/typescript-basics/package.json' with { type: 'json' };
import json from '../../../../extensions/json/package.json' with { type: 'json' };
import rust from '../../../../extensions/rust/package.json' with { type: 'json' };
import shellscript from '../../../../extensions/shellscript/package.json' with { type: 'json' };
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import * as stanza from '../../../src/ash/editor/editor.main.js';
import { StandaloneServices } from '../../../src/ash/editor/standalone/browser/standaloneServices.js';
import { StandardTokenType } from '../../../src/ash/editor/common/encodedTokenAttributes.js';
import type { ExtensionDescriptor } from '../../../src/ash/platform/extensions/common/extensionApi.js';
import { resolveTextResourceLanguageId } from '../../../src/ash/platform/language/common/textResourceLanguage.js';
import { AppServerExtensionService } from '../../../src/ash/workbench/services/extensions/browser/appServerExtensionService.js';
import { AppServerSyntaxProviders } from '../../../src/ash/workbench/services/language/browser/appServerSyntaxProviders.js';
import { BrowserTextMateService } from '../../../src/ash/workbench/services/textMate/browser/browserTextMateService.js';

const store = new DisposableStore();
const textMate = store.add(new BrowserTextMateService());
const services = store.add(StandaloneServices.initialize({ syntaxWorkerFactory: textMate.syntaxWorkerFactory }));
const shellResource = stanza.URI.file('/project/main.sh');
const baselineShellLanguage = services.languageService.guessLanguageIdByFilepathOrFirstLine(shellResource);
const resourceUrls = import.meta.glob<string>([
	'../../../../extensions/{javascript,typescript-basics,json,rust,shellscript}/syntaxes/*',
	'../../../../extensions/{javascript,typescript-basics,json,rust,shellscript}/*language-configuration.json',
	'../../../../extensions/{javascript,typescript-basics,json,rust,shellscript}/snippets/*',
], { eager: true, query: '?url', import: 'default' });
const directories = new Map<string, string>();
const descriptors: ExtensionDescriptor[] = [];
for (const [directory, manifest] of [['javascript', javascript], ['typescript-basics', typescript], ['json', json], ['rust', rust], ['shellscript', shellscript]] as const) {
	const manifestJson = JSON.stringify(manifest);
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(manifestJson));
	const hash = 'sha256:' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
	const id = `${manifest.publisher}.${manifest.name}`;
	directories.set(id, directory);
	descriptors.push({ id, name: manifest.name, publisher: manifest.publisher, version: manifest.version, displayName: manifest.displayName,
		sourceKind: 'builtIn', manifestJson, manifestSha256: hash, packageSha256: hash });
}
const extensions = store.add(new AppServerExtensionService({
	api: {
		list: async () => ({ generation: 1, diagnostics: [], extensions: descriptors }),
		readResource: async request => {
			const path = request.path.replace(/^\.\//u, '');
			const url = resourceUrls[`../../../../extensions/${directories.get(request.extensionId)}/${path}`];
			if (!url) throw new Error(`Missing extension fixture: ${request.extensionId}/${path}`);
			const response = await fetch(url);
			if (!response.ok) throw new Error(`Extension fixture failed: ${path}`);
			return new Uint8Array(await response.arrayBuffer());
		},
	},
	textMateService: textMate,
	languageService: services.languageService,
	languageConfigurationService: services.languageConfigurationService,
	languageFeaturesService: services.languageFeaturesService,
}));
await extensions.start();

let analyzeCalls = 0;
let completedCalls = 0;
const pending: (() => void)[] = [];
store.add(new AppServerSyntaxProviders(services.languageFeaturesService, {
	analyze: params => {
		analyzeCalls++;
		return new Promise(resolve => pending.push(() => {
			completedCalls++;
			resolve({ revision: params.revision, hasErrors: true, tokens: [], symbols: [], foldingRanges: [],
				diagnostics: [{ kind: 'error', range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 2 } } }] });
		}));
	},
	selectionRanges: async params => ({ revision: params.revision, ranges: [] }),
}));
let model = services.modelService.createModel('fn main() {}\n', services.languageService.createById('rust'), stanza.URI.file('/project/main.rs'));
const container = document.getElementById('editor')!;
const editor = store.add(stanza.editor.create(container, { model }));
editor.layout({ width: container.clientWidth, height: container.clientHeight });
const errors: string[] = [];
const listeners = store.add(new DisposableStore());
function observeModel(): void {
	listeners.clear();
	listeners.add(model.tokenization.onDidEncounterError(error => errors.push(String(error))));
	listeners.add(model.diagnostics.onDidEncounterError(error => errors.push(String(error))));
}
observeModel();

const integration = {
	open(languageId: string, text: string): void {
		const previous = model;
		model = services.modelService.createModel(text, services.languageService.createById(languageId));
		editor.setModel(model);
		observeModel();
		previous.dispose();
	},
	state() {
		return {
			text: model.getValue(), version: model.version, tokenVersion: model.tokenization.modelVersion,
			tokens: model.tokenization.lines.flatMap(line => line.tokens.map(token => ({ type: token.tokenType, text: model.getTextInRange(token.range) }))),
			analyzeCalls, completedCalls, errors,
			diagnosticVersion: model.diagnostics.results.result?.modelVersion ?? null,
		};
	},
	shellLanguages: () => [baselineShellLanguage, resolveTextResourceLanguageId({ resource: shellResource }), services.languageService.guessLanguageIdByFilepathOrFirstLine(shellResource)],
	stopUndo(): void { editor.pushUndoStop(); },
	async preview(): Promise<{ hasString: boolean; unchanged: boolean }> {
		const version = model.version;
		const tokens = await model.tokenization.tokenizeLinesAtAsync(1, ['fn preview() { "preview"; }'], new AbortController().signal);
		const line = tokens?.[0];
		const hasString = line !== undefined && Array.from({ length: line.getCount() }, (_, index) => line.getStandardTokenType(index)).includes(StandardTokenType.String);
		return { hasString, unchanged: model.version === version };
	},
	releaseAnalysis(): void { for (const resolve of pending.splice(0)) resolve(); },
	dispose(): void { editor.dispose(); model.dispose(); store.dispose(); integration.releaseAnalysis(); },
};
declare global { interface Window { tokenizationIntegration: typeof integration } }
window.tokenizationIntegration = integration;
