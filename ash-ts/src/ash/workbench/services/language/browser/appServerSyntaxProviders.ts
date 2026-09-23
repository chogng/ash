import { VSBuffer } from "../../../../base/common/buffer.js";
import { raceCancellationError } from "../../../../base/common/async.js";
import { Disposable, DisposableMap } from "../../../../base/common/lifecycle.js";
import type { ISyntaxApi, SyntaxAnalyzeResult, SyntaxDiagnostic, SyntaxSelectionRangesResult, SyntaxSymbol, SyntaxRange, SyntaxLanguage } from "../../../../platform/syntax/common/syntaxApi.js";
import { Position } from "../../../../editor/common/core/position.js";
import { Range } from "../../../../editor/common/core/range.js";
import { type TextSnapshot } from "../../../../editor/common/core/textChange.js";
import type { TextModel } from '../../../../editor/common/model/textModel.js';
import { type LanguageDocumentSymbol, type LanguageDocumentSymbolProvider, type LanguageDocumentSymbolRequest, type LanguageFoldingRange, type LanguageFoldingRangeProvider, type LanguageFoldingRangeRequest, type LanguageSelectionRangeProvider, type LanguageSelectionRangeRequest, type SyntaxProvider, type SyntaxProviderRequest, LanguageDiagnosticSeverity, type LanguageDiagnosticResult } from '../../../../editor/common/languages.js';
import type { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';

const MAX_SYNTAX_INPUT_BYTES = 4 * 1024 * 1024;

interface CachedSyntaxFacts {
	readonly language: SyntaxLanguage;
	readonly version: number;
	readonly text: string;
	readonly promise: Promise<SyntaxAnalyzeResult>;
}

/**
 * Registers asynchronous parser features; lexical tokens belong to the frontend TextMate Worker.
 */
export class AppServerSyntaxProviders extends Disposable {
	constructor(languageFeatures: ILanguageFeaturesService, api: ISyntaxApi) {
		super();
		const provider = this._register(new AppServerSyntaxProvider(api));
		this._register(languageFeatures.syntaxProvider.register(provider));
		this._register(languageFeatures.documentSymbolProvider.register(APP_SERVER_SYNTAX_LANGUAGE_IDS, provider));
		this._register(languageFeatures.foldingRangeProvider.register(APP_SERVER_SYNTAX_LANGUAGE_IDS, provider));
		this._register(languageFeatures.selectionRangeProvider.register(APP_SERVER_SYNTAX_LANGUAGE_IDS, provider));
	}
}

class AppServerSyntaxProvider extends Disposable implements SyntaxProvider, LanguageDocumentSymbolProvider, LanguageFoldingRangeProvider, LanguageSelectionRangeProvider {
	readonly id = "ash.appServer.syntax";
	readonly languageIds = APP_SERVER_SYNTAX_LANGUAGE_IDS;
	readonly diagnosticPriority = 100;
	private readonly sessions = this._register(new DisposableMap<TextModel, ModelSyntaxSession>());

	constructor(private readonly syntax: ISyntaxApi) {
		super();
	}

	async provideDiagnostics(request: SyntaxProviderRequest, signal: AbortSignal): Promise<LanguageDiagnosticResult | undefined> {
		if (!request.model) throw new Error('App Server syntax diagnostics require an editor model');
		const result = await this.analyze(request.model, request.languageId, request.snapshot, signal);
		return result ? projectAppServerSyntaxDiagnostics(result, request.snapshot) : undefined;
	}

	async provideDocumentSymbols(request: LanguageDocumentSymbolRequest, signal: AbortSignal): Promise<readonly LanguageDocumentSymbol[]> {
		const result = await this.analyze(request.model, request.languageId, request.snapshot, signal);
		return result ? projectAppServerSyntaxSymbols(result, request.snapshot) : Object.freeze([]);
	}

	async provideFoldingRanges(request: LanguageFoldingRangeRequest, signal: AbortSignal): Promise<readonly LanguageFoldingRange[]> {
		const result = await this.analyze(request.model, request.languageId, request.snapshot, signal);
		return result ? projectAppServerSyntaxFoldingRanges(result, request.snapshot) : Object.freeze([]);
	}

	async provideSelectionRanges(request: LanguageSelectionRangeRequest, signal: AbortSignal): Promise<readonly Range[]> {
		const language = syntaxLanguageForEditorLanguage(request.languageId);
		if (!language || request.ranges.length === 0) return Object.freeze([]);
		const text = request.snapshot.getText();
		if (VSBuffer.fromString(text).byteLength > MAX_SYNTAX_INPUT_BYTES) return Object.freeze([]);
		if (!this.session(request.model).accept(request.snapshot.version)) return Object.freeze([]);
		const result = await raceCancellationError(this.syntax.selectionRanges({
			documentId: request.model.id,
			language,
			revision: request.snapshot.version,
			text,
			ranges: request.ranges.map(range => ({
				start: { lineIndex: range.startLineNumber - 1, columnIndex: range.startColumn - 1 },
				end: { lineIndex: range.endLineNumber - 1, columnIndex: range.endColumn - 1 },
			})),
		}), signal, "App Server syntax selection request was cancelled");
		return projectAppServerSyntaxSelectionRanges(result, request.snapshot);
	}

	private async analyze(model: TextModel, languageId: string, snapshot: TextSnapshot, signal: AbortSignal): Promise<SyntaxAnalyzeResult | undefined> {
		const language = syntaxLanguageForEditorLanguage(languageId);
		if (!language) return undefined;
		const text = snapshot.getText();
		if (VSBuffer.fromString(text).byteLength > MAX_SYNTAX_INPUT_BYTES) return undefined;
		const session = this.session(model);
		const result = await session.analyze(language, snapshot.version, text, signal);
		if (!result) return undefined;
		if (result.revision !== snapshot.version) {
			throw new Error("App Server syntax result does not match the requested editor model revision");
		}
		return result;
	}

	private session(model: TextModel): ModelSyntaxSession {
		let session = this.sessions.get(model);
		if (!session) {
			session = this.sessions.set(model, new ModelSyntaxSession(this.syntax, model, () => this.sessions.deleteAndDispose(model)));
		}
		return session;
	}
}

class ModelSyntaxSession extends Disposable {
	private cached: CachedSyntaxFacts | undefined;
	private latestVersion = -1;

	constructor(private readonly syntax: ISyntaxApi, private readonly model: TextModel, onModelDispose: () => void) {
		super();
		this._register(model.onWillDispose(onModelDispose));
	}

	public async analyze(language: SyntaxLanguage, version: number, text: string, signal: AbortSignal): Promise<SyntaxAnalyzeResult | undefined> {
		if (!this.accept(version)) return undefined;
		let cached = this.cached;
		if (!cached || cached.language !== language || cached.version !== version || cached.text !== text) {
			const promise = this.syntax.analyze({ documentId: this.model.id, language, revision: version, text });
			cached = Object.freeze({ language, version, text, promise });
			this.cached = cached;
			void promise.catch(() => {
				if (this.cached === cached) this.cached = undefined;
			});
		}
		return raceCancellationError(cached.promise, signal, 'App Server syntax request was cancelled');
	}

	public accept(version: number): boolean {
		if (version < this.latestVersion) return false;
		this.latestVersion = version;
		return true;
	}

	protected override disposeCore(): void {
		super.disposeCore();
		void this.syntax.close({ documentId: this.model.id }).catch(error => console.error('Failed to release App Server syntax document', error));
	}
}

export const APP_SERVER_SYNTAX_LANGUAGE_IDS = Object.freeze(["javascript", "javascriptreact", "json", "jsonc", "rust", "shellscript", "typescript", "typescriptreact"]);

export function syntaxLanguageForEditorLanguage(languageId: string): "javascript" | "javascriptreact" | "json" | "jsonc" | "rust" | "shell" | "typescript" | "typescriptreact" | undefined {
	switch (languageId) {
		case "javascript": return "javascript";
		case "javascriptreact": return "javascriptreact";
		case "json": return "json";
		case "jsonc": return "jsonc";
		case "rust": return "rust";
		case "shellscript": return "shell";
		case "typescript": return "typescript";
		case "typescriptreact": return "typescriptreact";
		default: return undefined;
	}
}

export function projectAppServerSyntaxDiagnostics(result: SyntaxAnalyzeResult, snapshot: TextSnapshot): LanguageDiagnosticResult {
	assertMatchingRevision(result, snapshot);
	const lines = snapshotLines(snapshot);
	return Object.freeze({
		diagnostics: Object.freeze(result.diagnostics.flatMap(diagnostic => projectAppServerSyntaxDiagnostic(diagnostic, lines))),
	});
}

export function projectAppServerSyntaxSymbols(result: SyntaxAnalyzeResult, snapshot: TextSnapshot): readonly LanguageDocumentSymbol[] {
	assertMatchingRevision(result, snapshot);
	const lines = snapshotLines(snapshot);
	return Object.freeze(result.symbols.map(symbol => projectAppServerSyntaxSymbol(symbol, lines)));
}

export function projectAppServerSyntaxSelectionRanges(result: SyntaxSelectionRangesResult, snapshot: TextSnapshot): readonly Range[] {
	assertMatchingRevision(result, snapshot);
	const lines = snapshotLines(snapshot);
	return Object.freeze(result.ranges.map(selection => projectRange(selection.range, lines)));
}

export function projectAppServerSyntaxFoldingRanges(result: SyntaxAnalyzeResult, snapshot: TextSnapshot): readonly LanguageFoldingRange[] {
	assertMatchingRevision(result, snapshot);
	const ranges: LanguageFoldingRange[] = [];
	for (const foldingRange of result.foldingRanges) {
		const startLineIndex = foldingRange.range.start.lineIndex;
		const endLineIndex = foldingRange.range.end.lineIndex;
		if (!Number.isSafeInteger(startLineIndex) || !Number.isSafeInteger(endLineIndex) || startLineIndex < 0 || endLineIndex <= startLineIndex || endLineIndex >= snapshot.lineCount) continue;
		ranges.push(Object.freeze({ startLineIndex, endLineIndex }));
	}
	return Object.freeze(ranges);
}

function projectAppServerSyntaxDiagnostic(diagnostic: SyntaxDiagnostic, lines: readonly string[]) {
	const range = projectRange(diagnostic.range, lines);
	return Object.freeze({
		range,
		severity: LanguageDiagnosticSeverity.Error,
		message: diagnostic.kind === "missing" ? "Missing required syntax" : "Syntax error",
		code: diagnostic.kind === "missing" ? "syntax-missing" : "syntax-error",
		source: "ash-syntax",
	});
}

function projectAppServerSyntaxSymbol(symbol: SyntaxSymbol, lines: readonly string[]): LanguageDocumentSymbol {
	if (typeof symbol.name !== "string" || symbol.name.trim().length === 0) {
		throw new TypeError("App Server syntax symbol must have a non-empty name");
	}
	return Object.freeze({
		name: symbol.name,
		kind: symbol.kind,
		range: projectRange(symbol.range, lines),
		selectionRange: projectRange(symbol.selectionRange, lines),
	});
}

function projectRange(range: SyntaxRange, lines: readonly string[]): Range {
	return Range.fromPositions(projectPosition(range.start, lines), projectPosition(range.end, lines));
}

function projectPosition(position: { readonly lineIndex: number; readonly columnIndex: number }, lines: readonly string[]): Position {
	if (!Number.isSafeInteger(position.lineIndex) || !Number.isSafeInteger(position.columnIndex) || position.lineIndex < 0 || position.columnIndex < 0 || position.lineIndex >= lines.length || position.columnIndex > lines[position.lineIndex]!.length) {
		throw new RangeError("App Server syntax range is outside its editor snapshot");
	}
	return new Position((position.lineIndex) + 1, (position.columnIndex) + 1);
}

function snapshotLines(snapshot: TextSnapshot): readonly string[] {
	const text = snapshot.getText();
	const lines = text.split("\n");
	if (text.length !== snapshot.length || lines.length !== snapshot.lineCount) {
		throw new Error("Editor syntax snapshot metadata is inconsistent");
	}
	return Object.freeze(lines);
}

function assertMatchingRevision(result: Pick<SyntaxAnalyzeResult, "revision">, snapshot: TextSnapshot): void {
	if (result.revision !== snapshot.version) {
		throw new Error("App Server syntax result does not match the requested editor snapshot");
	}
}
