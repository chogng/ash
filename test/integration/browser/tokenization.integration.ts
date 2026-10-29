import { WebWorkerService } from '../../../src/ash/platform/webWorker/browser/webWorkerServiceImpl.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import {
	TreeSitterLibraryService,
	TreeSitterSyntaxProviders,
	createTreeSitterSyntaxSession,
} from '../../../src/ash/workbench/services/treeSitter/browser/treeSitterLibraryService.js';
import { rustSyntaxFixture } from '../../fixtures/browser/rustSyntaxHostFixture.js';
import { Range } from '../../../src/ash/editor/common/core/range.js';
import { LanguageDiagnosticSeverity } from '../../../src/ash/editor/common/languages.js';
import { SnippetsService } from '../../../src/ash/workbench/contrib/snippets/browser/snippetsService.js';
import { SnippetCompletionProvider } from '../../../src/ash/workbench/contrib/snippets/browser/snippetCompletionProvider.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import * as stanza from '../../../src/ash/editor/editor.main.js';
import { StandaloneServices } from '../../../src/ash/editor/standalone/browser/standaloneServices.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { StandardTokenType } from '../../../src/ash/editor/common/encodedTokenAttributes.js';
import { resolveTextResourceLanguageId } from '../../../src/ash/platform/language/common/textResourceLanguage.js';
import { createLanguageExtensions } from './languageExtensions.js';
import { AdapterManager } from '../../../src/ash/workbench/contrib/debug/browser/debugAdapterManager.js';

const store = new DisposableStore();
const library = store.add(new TreeSitterLibraryService(await rustSyntaxFixture(), new WebWorkerService()));
const services: ReturnType<typeof StandaloneServices.initialize> = store.add(
	StandaloneServices.initialize({
		tokenization: {
			createSyntaxSession: model =>
				createTreeSitterSyntaxSession(
					model,
					services.get(IConfigurationService),
					library,
					services.get(IThemeService),
				),
		},
	}),
);
store.add(new TreeSitterSyntaxProviders(services.languageFeaturesService));
await services.get(IConfigurationService).updateValue('files.eol', '\n');
const shellResource = stanza.URI.file('/project/main.sh');
const initialLanguages = services.languageService.getRegisteredLanguageIds();
const extensions = store.add(
	await createLanguageExtensions(
		{
			languageService: services.languageService,
			languageConfigurationService: services.languageConfigurationService,
		},
		store.add(new AdapterManager()),
	),
);
const snippets = store.add(new SnippetsService(extensions));
store.add(new SnippetCompletionProvider(snippets, services.languageFeaturesService));
await extensions.start();

let analyzeCalls = 0;
let completedCalls = 0;
const pending: { revision: number; resolve: () => void }[] = [];
store.add(
	services.languageFeaturesService.syntaxProvider.register({
		id: 'test.delayedDiagnostics',
		languageIds: [
			'rust',
			'javascript',
			'javascriptreact',
			'typescript',
			'typescriptreact',
			'json',
			'jsonc',
			'shellscript',
		],
		diagnosticPriority: 200,
		provideDiagnostics: request => {
			analyzeCalls++;
			return new Promise(resolve =>
				pending.push({
					revision: request.snapshot.version,
					resolve: () => {
						completedCalls++;
						resolve({
							diagnostics: [
								{
									severity: LanguageDiagnosticSeverity.Error,
									message: 'Test diagnostic',
									range: new Range(1, 1, 1, 3),
								},
							],
						});
					},
				}),
			);
		},
	}),
);
let model = services.modelService.createModel(
	'fn main() {}\n',
	services.languageService.createById('rust'),
	stanza.URI.file('/project/main.rs'),
);
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
	open(languageId: string, text: string, path?: string): void {
		const previous = model;
		model = services.modelService.createModel(
			text,
			services.languageService.createById(languageId),
			path === undefined ? undefined : stanza.URI.file(path),
		);
		editor.setModel(model);
		observeModel();
		previous.dispose();
	},
	openResource(path: string, text: string): string {
		const resource = stanza.URI.file(path);
		const languageId = resolveTextResourceLanguageId(
			{ resource, firstLine: text.split('\n')[0] },
			services.languageService,
		);
		integration.open(languageId, text, path);
		return model.getLanguageId();
	},
	state() {
		return {
			text: model.getValue(),
			version: model.version,
			tokenVersion: model.tokenization.modelVersion,
			accurate: model.tokenization.hasAccurateTokensForLine(model.getLineCount()),
			tokens: model.tokenization.lines.flatMap(line =>
				line.tokens.map(token => ({ type: token.tokenType, text: model.getTextInRange(token.range) })),
			),
			analyzeCalls,
			completedCalls,
			pendingVersions: pending.map(request => request.revision),
			errors,
			diagnosticVersion: model.diagnostics.results.result?.modelVersion ?? null,
		};
	},
	languageState: () => ({
		initial: initialLanguages,
		shell: services.languageService.guessLanguageIdByFilepathOrFirstLine(shellResource),
		resource: resolveTextResourceLanguageId({ resource: shellResource }, services.languageService),
		comment:
			services.languageConfigurationService.getLanguageConfiguration('shellscript').comments?.lineCommentToken ??
			null,
		grammar: !!model.tokenization.syntaxTree,
		model: model.getLanguageId(),
	}),
	async unloadExtensions(): Promise<void> {
		extensions.dispose();
	},
	stopUndo(): void {
		editor.pushUndoStop();
	},
	async preview(): Promise<{ hasString: boolean; unchanged: boolean }> {
		const version = model.version;
		const tokens = await model.tokenization.tokenizeLinesAtAsync(
			1,
			['fn preview() { "preview"; }'],
			new AbortController().signal,
		);
		const line = tokens?.[0];
		const hasString =
			line !== undefined &&
			Array.from({ length: line.getCount() }, (_, index) => line.getStandardTokenType(index)).includes(
				StandardTokenType.String,
			);
		return { hasString, unchanged: model.version === version };
	},
	async forceRetokenize(): Promise<{ version: number; accurate: boolean }> {
		const action = editor.getAction('editor.action.forceRetokenize');
		if (!action) throw new Error('Force Retokenize action is not registered');
		await action.run();
		return { version: model.version, accurate: model.tokenization.hasAccurateTokensForLine(model.getLineCount()) };
	},
	releaseAnalysis(): void {
		pending.shift()?.resolve();
	},
	dispose(): void {
		editor.dispose();
		model.dispose();
		store.dispose();
		for (const request of pending.splice(0)) request.resolve();
	},
};
declare global {
	interface Window {
		tokenizationIntegration: typeof integration;
	}
}
window.tokenizationIntegration = integration;
