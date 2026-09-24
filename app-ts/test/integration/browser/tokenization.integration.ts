import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import * as stanza from '../../../src/ash/editor/editor.main.js';
import { StandaloneServices } from '../../../src/ash/editor/standalone/browser/standaloneServices.js';
import { StandardTokenType } from '../../../src/ash/editor/common/encodedTokenAttributes.js';
import { resolveTextResourceLanguageId } from '../../../src/ash/platform/language/common/textResourceLanguage.js';
import { createLanguageExtensions } from './languageExtensions.js';
import { AppServerSyntaxProviders } from '../../../src/ash/workbench/services/language/browser/appServerSyntaxProviders.js';
import { BrowserTextMateService } from '../../../src/ash/workbench/services/textMate/browser/browserTextMateService.js';

const store = new DisposableStore();
const textMate = store.add(new BrowserTextMateService());
const services = store.add(StandaloneServices.initialize({ syntaxWorkerFactory: textMate.syntaxWorkerFactory }));
const shellResource = stanza.URI.file('/project/main.sh');
const initialLanguages = services.languageService.getRegisteredLanguageIds();
const extensions = store.add(await createLanguageExtensions({
	textMateService: textMate,
	languageService: services.languageService,
	languageConfigurationService: services.languageConfigurationService,
	languageFeaturesService: services.languageFeaturesService,
}));
await extensions.start();

let analyzeCalls = 0;
let completedCalls = 0;
const pending: { revision: number; resolve: () => void }[] = [];
store.add(new AppServerSyntaxProviders(services.languageFeaturesService, {
	generation: 1,
	open: async () => {},
	update: async () => {},
	analyze: params => {
		analyzeCalls++;
		return new Promise(resolve => pending.push({ revision: params.revision, resolve: () => {
			completedCalls++;
			resolve({ revision: params.revision, hasErrors: true, tokens: [], symbols: [], foldingRanges: [],
				diagnostics: [{ kind: 'error', range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 2 } } }] });
		} }));
	},
	selectionRanges: async params => ({ revision: params.revision, ranges: [] }),
	close: async () => {},
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
			analyzeCalls, completedCalls, pendingVersions: pending.map(request => request.revision), errors,
			diagnosticVersion: model.diagnostics.results.result?.modelVersion ?? null,
		};
	},
	languageState: () => ({
		initial: initialLanguages,
		shell: services.languageService.guessLanguageIdByFilepathOrFirstLine(shellResource),
		resource: resolveTextResourceLanguageId({ resource: shellResource }, services.languageService),
		comment: services.languageConfigurationService.getLanguageConfiguration('shellscript').comments?.lineCommentToken ?? null,
		grammar: textMate.grammars.currentCatalog.grammars.some(grammar => grammar.languageId === 'shellscript'),
		model: model.getLanguageId(),
	}),
	async unloadExtensions(): Promise<void> {
		extensions.dispose();
		await textMate.grammars.whenReady();
	},
	stopUndo(): void { editor.pushUndoStop(); },
	async preview(): Promise<{ hasString: boolean; unchanged: boolean }> {
		const version = model.version;
		const tokens = await model.tokenization.tokenizeLinesAtAsync(1, ['fn preview() { "preview"; }'], new AbortController().signal);
		const line = tokens?.[0];
		const hasString = line !== undefined && Array.from({ length: line.getCount() }, (_, index) => line.getStandardTokenType(index)).includes(StandardTokenType.String);
		return { hasString, unchanged: model.version === version };
	},
	releaseAnalysis(): void { for (const request of pending.splice(0)) request.resolve(); },
	dispose(): void { editor.dispose(); model.dispose(); store.dispose(); integration.releaseAnalysis(); },
};
declare global { interface Window { tokenizationIntegration: typeof integration } }
window.tokenizationIntegration = integration;
