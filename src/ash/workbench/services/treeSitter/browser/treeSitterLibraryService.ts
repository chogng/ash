import type { TextModelSyntaxSession } from '../../../../editor/common/tokenizationTextModelPart.js';
import { isWeb } from '../../../../base/common/platform.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { type IWebWorkerClient } from '../../../../base/common/worker/webWorker.js';
import { IWebWorkerService } from '../../../../platform/webWorker/browser/webWorkerService.js';
import { WebWorkerDescriptor } from '../../../../platform/webWorker/browser/webWorkerDescriptor.js';
import { syntaxLanguageForEditorLanguage, syntaxEditorLanguageIds } from '../../../../platform/syntax/common/syntaxApi.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { ISyntaxApi } from '../../../../platform/syntax/common/syntaxApi.js';
import { createAppServerTreeSitterSession } from './appServerTreeSitterSession.js';
import { Range } from '../../../../editor/common/core/range.js';
import { LanguageDiagnosticSeverity, nestDocumentSymbols, type LanguageDocumentSymbol } from '../../../../editor/common/languages.js';
import { localize } from '../../../../nls.js';
import { Disposable, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { ITreeSitterLibraryService, treeSitterChannel, type TreeSitterSyntaxSession } from '../../../../editor/common/services/treeSitter/treeSitterLibraryService.js';
import type { TreeSitterFacts, TreeSitterSyntaxResult } from '../../../../editor/common/services/treeSitter/treeSitterLibraryService.js';
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { TextModel } from '../../../../editor/common/model/textModel.js';

/** Rust owns connected syntax sessions; Web uses a local Worker while the connection is unavailable. */
export class TreeSitterLibraryService extends Disposable implements ITreeSitterLibraryService {
	declare readonly _serviceBrand: undefined;
	private readonly worker = this._register(new MutableDisposable<IWebWorkerClient<object>>());
	private readonly workerFailure = this._register(new MutableDisposable<IDisposable>());
	private readonly changed = this._register(new Emitter<void>());
	private canRecover = true;
	private documentId = 0;
	private requestId = 0;

	constructor(@ISyntaxApi private readonly syntax: ISyntaxApi, @IWebWorkerService private readonly workers: IWebWorkerService) { super(); }
	get onDidChange() { return Event.any(this.syntax.onDidChangeConnection, this.changed.event); }
	supportsLanguage(languageId: string): boolean {
		return (isWeb || this.syntax.isAvailable) && syntaxLanguageForEditorLanguage(languageId) !== undefined;
	}
	createSession(model: TextModel): TreeSitterSyntaxSession {
		this.assertNotDisposed();
		if (!isWeb || this.syntax.isAvailable) return createAppServerTreeSitterSession(this.syntax, model, `shared-tree-${++this.documentId}`);
		const worker = this.worker.value ?? this.createWorker(), document = ++this.documentId;
		worker.send('open', { document, text: model.getValue(), eol: model.getEOL(), revision: model.version, language: model.getLanguageId() });
		let disposed = false;
		const disposable = toDisposable(() => {
			disposed = true;
			if (!this.isDisposed && this.worker.value === worker) worker.send('close', { document });
		});
		return {
			...disposable,
			execution: 'worker',
			setTabSize: tabSize => { if (!disposed) worker.send('options', { document, tabSize }); },
			update: change => { if (!disposed) worker.send('update', { document, change }); },
			request: async (operation, data, signal) => {
				if (disposed) throw new Error('Syntax session is disposed');
				const result = await worker.request(++this.requestId, { ...data, document, revision: model.version, operation }, signal);
				this.canRecover = true;
				return decodeResult(result, model);
			},
		};
	}

	private createWorker(): IWebWorkerClient<object> {
		const worker = this.workers.createWorkerClient(new WebWorkerDescriptor({
			label: 'ash-tree-sitter', channel: treeSitterChannel,
			createWorker: () => new Worker(new URL('./treeSitterWorkerMain.ts', import.meta.url), { type: 'module', name: 'ash-tree-sitter' }),
		}));
		this.worker.value = worker;
		this.workerFailure.value = worker.onDidFail(() => {
			this.workerFailure.clear();
			this.worker.clear();
			// A healthy replacement replenishes the budget. A persistent startup
			// failure must not turn model rebuilding into an unbounded restart loop.
			if (this.canRecover) {
				this.canRecover = false;
				this.changed.fire();
			}
		});
		return worker;
	}
}

function decodeResult(value: unknown, model: TextModel): TreeSitterSyntaxResult {
	if (!value || typeof value !== 'object') throw new TypeError('Invalid syntax Worker result');
	const result = value as TreeSitterSyntaxResult;
	if (!Number.isSafeInteger(result.revision) || !Array.isArray(result.measures)) throw new TypeError('Invalid syntax Worker revision');
	for (const measure of result.measures) if (!['parse', 'query', 'facts'].includes(measure.operation) || !Number.isFinite(measure.duration) || measure.duration < 0 || typeof measure.incremental !== 'boolean') throw new TypeError('Invalid syntax measurement');
	const range = (value: import('../../../../editor/common/core/range.js').IRange): void => {
		if (!value || ![value.startLineNumber, value.endLineNumber, value.startColumn, value.endColumn].every(n => Number.isSafeInteger(n) && n > 0) || value.startLineNumber > value.endLineNumber || value.startLineNumber === value.endLineNumber && value.startColumn > value.endColumn) throw new TypeError('Invalid syntax result range');
	};
	if (result.brackets) { if (!Array.isArray(result.brackets)) throw new TypeError('Invalid syntax brackets'); for (const pair of result.brackets) { range(pair.range); range(pair.opening); if (pair.closing) range(pair.closing); if (typeof pair.text !== 'string' || !Number.isSafeInteger(pair.level) || pair.level < 0 || !Number.isSafeInteger(pair.equalLevel)) throw new TypeError('Invalid syntax bracket'); } }
	if (result.rows !== undefined) {
		if (!Array.isArray(result.rows)) throw new TypeError('Invalid syntax rows');
		for (const row of result.rows) {
			if (!Number.isSafeInteger(row.row) || row.row < 0 || !Array.isArray(row.tokens)) throw new TypeError('Invalid syntax row');
			for (const token of row.tokens) if (!Number.isSafeInteger(token.start) || !Number.isSafeInteger(token.end) || token.start < 0 || token.end <= token.start || typeof token.name !== 'string' || token.languageId !== undefined && typeof token.languageId !== 'string') throw new TypeError('Invalid syntax capture');
		}
	}
	if (result.facts) {
		if (!Array.isArray(result.facts.folds) || !Array.isArray(result.facts.symbols) || !Array.isArray(result.facts.diagnostics)) throw new TypeError('Invalid syntax facts');
		for (const fold of result.facts.folds) if (!Number.isSafeInteger(fold.startLineIndex) || !Number.isSafeInteger(fold.endLineIndex) || fold.startLineIndex < 0 || fold.endLineIndex <= fold.startLineIndex) throw new TypeError('Invalid syntax fold');
		for (const symbol of result.facts.symbols) { if (typeof symbol.name !== 'string' || typeof symbol.kind !== 'string') throw new TypeError('Invalid syntax symbol'); range(symbol.range); range(symbol.selectionRange); }
		for (const diagnostic of result.facts.diagnostics) { range(diagnostic.range); if (typeof diagnostic.missing !== 'boolean') throw new TypeError('Invalid syntax diagnostic'); }
	}
	if (result.selections) { if (!Array.isArray(result.selections)) throw new TypeError('Invalid syntax selections'); result.selections.forEach(range); }
	// Stale revisions are discarded by each document consumer, before ranges touch its buffer.
	if (result.revision > model.version) throw new RangeError('Syntax Worker is ahead of the editor');
	return result;
}

export function createTreeSitterSyntaxSession(model: TextModel, configuration: IConfigurationService, library: ITreeSitterLibraryService, themes: IThemeService): TextModelSyntaxSession | undefined {
	if (!library.supportsLanguage(model.getLanguageId())) return undefined;
	const session = library.createSession(model);
	return {
		session, resolveStyle: (capture, language) => {
			const [tokenType, ...modifiers] = capture.split('.');
			const theme = themes.getColorTheme();
			const metadata = theme.getTokenStyleMetadata(tokenType!, modifiers, language);
			const fontStyle = metadata ? (['italic', 'bold', 'underline', 'strikethrough'] as const).filter(style => metadata[style]) : undefined;
			return {
				tokenType: tokenType!, modifiers,
				...(metadata?.foreground === undefined ? {} : { foreground: theme.tokenColorMap[metadata.foreground] }),
				...(fontStyle?.length ? { fontStyle } : {}),
			};
		}, measure: configuration.getValue('editor.experimental.treeSitterTelemetry') === true ? sample => {
			performance.measure(`ash.treeSitter.${sample.operation}`, { start: performance.now() - sample.duration, duration: sample.duration, detail: { ...sample, version: model.version, model: model.uri.path, execution: session.execution } });
		} : undefined
	};
}

/** Registers shared-tree consumers in both Desktop and Browser hosts. */
export class TreeSitterSyntaxProviders extends Disposable {
	private readonly symbols = new WeakMap<TreeSitterFacts, Promise<readonly LanguageDocumentSymbol[]>>();
	private readonly symbolItems = new WeakMap<TreeSitterFacts['symbols'][number], LanguageDocumentSymbol>();
	constructor(features: import('../../../../editor/common/services/languageFeatures.js').ILanguageFeaturesService) {
		super();
		const languages = syntaxEditorLanguageIds;
		this._register(features.documentSymbolProvider.register(languages, {
			provideDocumentSymbols: async (request, signal) => {
				const facts = await request.model.tokenization.syntaxTree?.getFacts(signal);
				if (!facts) return [];
				let pending = this.symbols.get(facts);
				if (!pending) {
					pending = this.documentSymbols(facts, request.model, request.snapshot.version);
					this.symbols.set(facts, pending);
					void pending.catch(() => this.symbols.delete(facts));
				}
				return raceCancellationError(pending, signal, 'Document symbols cancelled');
			}
		}));
		this._register(features.foldingRangeProvider.register(languages, { id: 'ash.treeSitter.syntax', provideFoldingRanges: async (request, signal) => (await request.model.tokenization.syntaxTree?.getFacts(signal))?.folds ?? [] }));
		this._register(features.selectionRangeProvider.register(languages, { provideSelectionRanges: async (request, signal) => await request.model.tokenization.syntaxTree?.getSelectionRanges(request.ranges, signal) ?? [] }));
		this._register(features.syntaxProvider.register({
			id: 'ash.treeSitter.syntax', languageIds: languages, diagnosticPriority: 100, provideDiagnostics: async (request, signal) => {
				const tree = request.model?.tokenization.syntaxTree; if (!tree) return undefined;
				const facts = await tree.getFacts(signal);
				return { diagnostics: facts.diagnostics.map(diagnostic => ({ range: Range.lift(diagnostic.range), severity: LanguageDiagnosticSeverity.Error, message: diagnostic.missing ? localize('treeSitter.missingSyntax', 'Missing required syntax') : localize('treeSitter.syntaxError', 'Syntax error'), code: diagnostic.missing ? 'syntax-missing' : 'syntax-error', source: 'ash-syntax' })) };
			}
		}));
	}
	private async documentSymbols(facts: TreeSitterFacts, model: TextModel, version: number): Promise<readonly LanguageDocumentSymbol[]> {
		const symbols: LanguageDocumentSymbol[] = [];
		for (let start = 0; start < facts.symbols.length; start += 4096) {
			if (this.isDisposed || model.isDisposed() || model.version !== version) throw new CancellationError();
			for (const source of facts.symbols.slice(start, start + 4096)) {
				let symbol = this.symbolItems.get(source);
				if (!symbol) {
					symbol = {
						...source,
						kind: model.getLanguageId() === 'markdown' && source.kind === 'module' ? 'string' : symbolKind(source.kind),
						range: Range.lift(source.range),
						selectionRange: Range.lift(source.selectionRange),
					};
					this.symbolItems.set(source, symbol);
				}
				symbols.push(symbol);
			}
			// Share version-bound work between consumers. Their cancellation stays
			// independent; an edit/disposal ends the underlying work at the next slice.
			if (start + 4096 < facts.symbols.length) await new Promise<void>(resolve => setTimeout(resolve, 0));
		}
		if (this.isDisposed || model.isDisposed() || model.version !== version) throw new CancellationError();
		return nestDocumentSymbols(symbols);
	}
}
function symbolKind(kind: string): string { return kind === 'property' ? 'field' : kind === 'class' ? 'struct' : kind === 'interface' ? 'trait' : kind; }
