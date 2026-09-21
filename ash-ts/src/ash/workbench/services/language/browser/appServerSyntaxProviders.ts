import { VSBuffer } from "../../../../base/common/buffer.js";
import { raceCancellationError } from "../../../../base/common/async.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import type { ISyntaxApi, SyntaxAnalyzeResult, SyntaxDiagnostic, SyntaxSelectionRangesResult, SyntaxSymbol, SyntaxToken } from "../../../../platform/syntax/common/syntaxApi.js";
import { type LanguageDocumentSymbol, type LanguageDocumentSymbolProvider, type LanguageDocumentSymbolRequest } from "../../../../editor/contrib/documentSymbols/common/languageDocumentSymbols.js";
import { type LanguageFoldingRange, type LanguageFoldingRangeProvider, type LanguageFoldingRangeRequest } from "../../../../editor/contrib/folding/common/languageFoldingRanges.js";
import { type LanguageSelectionRangeProvider, type LanguageSelectionRangeRequest } from "../../../../editor/contrib/smartSelect/common/selectionRanges.js";
import { Position } from "../../../../editor/common/core/position.js";
import { Range } from "../../../../editor/common/core/range.js";
import { type TextSnapshot } from "../../../../editor/common/core/textChange.js";
import { type SyntaxProvider, type SyntaxProviderRequest, LanguageDiagnosticSeverity, type LanguageDiagnosticResult } from '../../../../editor/common/languages.js';
import { type LanguageToken, type LanguageTokenResult } from '../../../../editor/common/tokens/languageTokens.js';
import type { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';

const MAX_SYNTAX_INPUT_BYTES = 4 * 1024 * 1024;

interface CachedSyntaxFacts {
	readonly key: string;
	readonly promise: Promise<SyntaxAnalyzeResult>;
}

/**
 * Registers the App Server parser as ordinary Editor language providers.
 */
export class AppServerSyntaxProviders extends Disposable {
	constructor(languageFeatures: ILanguageFeaturesService, api: ISyntaxApi) {
		super();
		const provider = new AppServerSyntaxProvider(api);
		this._register(languageFeatures.syntaxProvider.register(provider));
		this._register(languageFeatures.documentSymbolProvider.register(APP_SERVER_SYNTAX_LANGUAGE_IDS, provider));
		this._register(languageFeatures.foldingRangeProvider.register(APP_SERVER_SYNTAX_LANGUAGE_IDS, provider));
		this._register(languageFeatures.selectionRangeProvider.register(APP_SERVER_SYNTAX_LANGUAGE_IDS, provider));
	}
}

class AppServerSyntaxProvider implements SyntaxProvider, LanguageDocumentSymbolProvider, LanguageFoldingRangeProvider, LanguageSelectionRangeProvider {
	readonly id = "ash.appServer.syntax";
	readonly languageIds = APP_SERVER_SYNTAX_LANGUAGE_IDS;
	readonly tokenPriority = 100;
	readonly diagnosticPriority = 100;
	private cached: CachedSyntaxFacts | undefined;

	constructor(private readonly syntax: ISyntaxApi) {}

	async provideTokens(request: SyntaxProviderRequest, signal: AbortSignal): Promise<LanguageTokenResult | undefined> {
		const result = await this.analyze(request.languageId, request.snapshot, signal);
		return result ? projectAppServerSyntaxTokens(result, request.snapshot) : undefined;
	}

	async provideDiagnostics(request: SyntaxProviderRequest, signal: AbortSignal): Promise<LanguageDiagnosticResult | undefined> {
		const result = await this.analyze(request.languageId, request.snapshot, signal);
		return result ? projectAppServerSyntaxDiagnostics(result, request.snapshot) : undefined;
	}

	async provideDocumentSymbols(request: LanguageDocumentSymbolRequest, signal: AbortSignal): Promise<readonly LanguageDocumentSymbol[]> {
		const result = await this.analyze(request.languageId, request.snapshot, signal);
		return result ? projectAppServerSyntaxSymbols(result, request.snapshot) : Object.freeze([]);
	}

	async provideFoldingRanges(request: LanguageFoldingRangeRequest, signal: AbortSignal): Promise<readonly LanguageFoldingRange[]> {
		const result = await this.analyze(request.languageId, request.snapshot, signal);
		return result ? projectAppServerSyntaxFoldingRanges(result, request.snapshot) : Object.freeze([]);
	}

	async provideSelectionRanges(request: LanguageSelectionRangeRequest, signal: AbortSignal): Promise<readonly Range[]> {
		const language = syntaxLanguageForEditorLanguage(request.languageId);
		if (!language || request.ranges.length === 0) return Object.freeze([]);
		const text = request.snapshot.getText();
		if (VSBuffer.fromString(text).byteLength > MAX_SYNTAX_INPUT_BYTES) return Object.freeze([]);
		const result = await raceCancellationError(this.syntax.selectionRanges({
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

	private async analyze(languageId: string, snapshot: TextSnapshot, signal: AbortSignal): Promise<SyntaxAnalyzeResult | undefined> {
		const language = syntaxLanguageForEditorLanguage(languageId);
		if (!language) return undefined;
		const text = snapshot.getText();
		if (VSBuffer.fromString(text).byteLength > MAX_SYNTAX_INPUT_BYTES) return undefined;
		const key = `${language}\u0000${snapshot.version}\u0000${text}`;
		let cached = this.cached;
		if (!cached || cached.key !== key) {
			const promise = this.syntax.analyze(Object.freeze({ language, revision: snapshot.version, text }));
			cached = Object.freeze({ key, promise });
			this.cached = cached;
			void promise.catch(() => {
				if (this.cached === cached) this.cached = undefined;
			});
		}
		const result = await raceCancellationError(cached.promise, signal, "App Server syntax request was cancelled");
		if (result.revision !== snapshot.version) {
			throw new Error("App Server syntax result does not match the requested editor model revision");
		}
		return result;
	}
}

export const APP_SERVER_SYNTAX_LANGUAGE_IDS = Object.freeze(["javascript", "javascriptreact", "json", "jsonc", "rust", "shell", "typescript", "typescriptreact"]);

export function syntaxLanguageForEditorLanguage(languageId: string): "javascript" | "javascriptreact" | "json" | "jsonc" | "rust" | "shell" | "typescript" | "typescriptreact" | undefined {
	switch (languageId) {
		case "javascript": return "javascript";
		case "javascriptreact": return "javascriptreact";
		case "json": return "json";
		case "jsonc": return "jsonc";
		case "rust": return "rust";
		case "shell": return "shell";
		case "typescript": return "typescript";
		case "typescriptreact": return "typescriptreact";
		default: return undefined;
	}
}

export function projectAppServerSyntaxTokens(result: SyntaxAnalyzeResult, snapshot: TextSnapshot): LanguageTokenResult {
	assertMatchingRevision(result, snapshot);
	const lines = snapshotLines(snapshot);
	const tokens: LanguageToken[] = [];
	for (const token of result.tokens) {
		for (const range of projectSingleLineRanges(token.range, lines)) {
			overlayToken(tokens, Object.freeze({
				range,
				tokenType: syntaxTokenType(token),
				modifiers: Object.freeze([]),
			}));
		}
	}
	return Object.freeze({ tokens: Object.freeze(tokens) });
}

function overlayToken(tokens: LanguageToken[], incoming: LanguageToken): void {
	const retained: LanguageToken[] = [];
	for (const token of tokens) {
		if (Position.compare(token.range.getEndPosition(), incoming.range.getStartPosition()) <= 0 || Position.compare(incoming.range.getEndPosition(), token.range.getStartPosition()) <= 0) {
			retained.push(token);
			continue;
		}
		if (Position.compare(token.range.getStartPosition(), incoming.range.getStartPosition()) < 0) retained.push(tokenWithRange(token, Range.fromPositions(token.range.getStartPosition(), incoming.range.getStartPosition())));
		if (Position.compare(incoming.range.getEndPosition(), token.range.getEndPosition()) < 0) retained.push(tokenWithRange(token, Range.fromPositions(incoming.range.getEndPosition(), token.range.getEndPosition())));
	}
	retained.push(incoming);
	retained.sort((left, right) => Position.compare(left.range.getStartPosition(), right.range.getStartPosition()) || Position.compare(left.range.getEndPosition(), right.range.getEndPosition()));
	tokens.splice(0, tokens.length, ...retained);
}

function tokenWithRange(token: LanguageToken, range: Range): LanguageToken {
	return Object.freeze({
		range,
		tokenType: token.tokenType,
		modifiers: token.modifiers,
		...(token.languageId === undefined ? {} : { languageId: token.languageId }),
		...(token.balancedBrackets === false ? { balancedBrackets: false as const } : {}),
		...(token.presentation === undefined ? {} : { presentation: token.presentation }),
	});
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

function syntaxTokenType(token: SyntaxToken): string {
	switch (token.kind) {
		case "attribute": return "modifier";
		case "comment": return "comment";
		case "constant": return "variable";
		case "constructor": return "class";
		case "embedded": return "string";
		case "function": return "function";
		case "keyword": return "keyword";
		case "label": return "variable";
		case "module": return "namespace";
		case "number": return "number";
		case "operator": return "operator";
		case "property": return "property";
		case "punctuation": return "punctuation";
		case "string": return "string";
		case "type": return "type";
		case "variable": return "variable";
	}
}

function projectSingleLineRanges(range: SyntaxToken["range"], lines: readonly string[]): readonly Range[] {
	const projected = projectRange(range, lines);
	if (projected.isEmpty()) return Object.freeze([]);
	const ranges: Range[] = [];
	for (let lineNumber = projected.startLineNumber; lineNumber <= projected.endLineNumber; lineNumber += 1) {
		const startColumn = lineNumber === projected.startLineNumber ? projected.startColumn : 1;
		const endColumn = lineNumber === projected.endLineNumber ? projected.endColumn : lines[lineNumber - 1]!.length + 1;
		if (endColumn > startColumn) ranges.push(new Range(lineNumber, startColumn, lineNumber, endColumn));
	}
	return Object.freeze(ranges);
}

function projectRange(range: SyntaxToken["range"], lines: readonly string[]): Range {
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
