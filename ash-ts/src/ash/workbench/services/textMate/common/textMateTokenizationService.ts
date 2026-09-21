import { arraysEqual, commonArraySuffixLength, commonPrefixLength } from "../../../../base/common/arrays.js";
import { escapeRegExpCharacters } from "../../../../base/common/strings.js";
import { type LanguageWorkerDocumentSynchronization } from '../../../../editor/common/services/textModelSync/textModelSync.protocol.js';
import { type LanguageToken, type LanguageTokenResult } from '../../../../editor/common/tokens/languageTokens.js';
import { Position } from "../../../../editor/common/core/position.js";
import { Range } from "../../../../editor/common/core/range.js";
import { type TextSnapshot } from "../../../../editor/common/core/textChange.js";
import { defaultTextMateScopeResolver, type TextMateResolvedTokenStyle, type TextMateScopeResolver } from "./textMateScopeResolver.js";
import { type TextMateGrammarContent, type RegisteredTextMateGrammarDefinition, type TextMateGrammarRegistrySnapshot, type TextMateGrammarTokenType } from "./textMateGrammarRegistry.js";
import * as textMateNamespace from "vscode-textmate";
import { type IGrammar, type IGrammarConfiguration, type IOnigLib, type IRawGrammar, type Registry as TextMateRegistry, type StateStack } from "vscode-textmate";

const textMateRuntime = (textMateNamespace as unknown as { readonly default?: typeof textMateNamespace }).default ?? textMateNamespace;
const { INITIAL, Registry, parseRawGrammar } = textMateRuntime;

export interface TextMateGrammarSnapshotSource {
	readonly currentSnapshot: TextMateGrammarRegistrySnapshot;
}

export interface TextMateTokenizationCacheUpdate {
	readonly modelVersion: number;
	readonly languageId: string;
	readonly kind: "full" | "incremental";
	readonly scannedLineCount: number;
	readonly reusedLineCount: number;
}

export interface TextMateTokenizationServiceOptions {
	readonly lineTimeLimitMilliseconds?: number;
	readonly scopeResolver?: TextMateScopeResolver;
	readonly onDidUpdateCache?: (update: TextMateTokenizationCacheUpdate) => void;
}

interface TextMateRelativeToken {
	readonly startColumn: number;
	readonly endColumn: number;
	readonly tokenType: string;
	readonly modifiers: readonly string[];
	readonly languageId?: string;
	readonly balancedBrackets?: false;
	readonly presentation?: LanguageToken["presentation"];
}

interface TextMateLineResult {
	readonly inputState: StateStack;
	readonly outputState: StateStack;
	readonly tokens: readonly TextMateRelativeToken[];
}

interface TextMateScopeMetadata {
	readonly languageId?: string;
	readonly balancedBrackets?: false;
}

type TextMateScopeMetadataResolver = (scopes: readonly string[]) => TextMateScopeMetadata;

interface TextMateTokenizationDocument {
	readonly version: number;
	readonly lines: readonly string[];
	readonly lineResults: readonly TextMateLineResult[];
	readonly tokens: LanguageTokenResult;
}

interface TextMateRuntimeState {
	readonly snapshot: TextMateGrammarRegistrySnapshot;
	readonly registry: TextMateRegistry;
	readonly languageNumbers: ReadonlyMap<string, number>;
	readonly grammars: Map<string, Promise<IGrammar | undefined>>;
	readonly caches: Map<string, TextMateTokenizationCache>;
	users: number;
	retired: boolean;
}

/** Owns TextMate runtimes and incremental token state for one tokenization document. */
export class TextMateTokenizationService implements Disposable {
	private readonly lineTimeLimitMilliseconds: number;
	private readonly scopeResolver: TextMateScopeResolver;
	private readonly onDidUpdateCache: TextMateTokenizationServiceOptions["onDidUpdateCache"];
	private readonly onigLib: Promise<IOnigLib>;
	private currentState: TextMateRuntimeState | undefined;
	private disposed = false;

	constructor(
		private readonly grammars: TextMateGrammarSnapshotSource,
		onigLib: PromiseLike<IOnigLib>,
		options: TextMateTokenizationServiceOptions = {},
	) {
		if (!grammars || typeof grammars !== "object" || !("currentSnapshot" in grammars)) {
			throw new TypeError("TextMate tokenization service requires a grammar snapshot source");
		}
		if (!onigLib || typeof onigLib !== "object" || typeof onigLib.then !== "function") {
			throw new TypeError("TextMate tokenization service requires an Oniguruma promise");
		}
		this.onigLib = Promise.resolve(onigLib);
		if (typeof options !== "object" || options === null) {
			throw new TypeError("TextMate tokenization service options must be an object");
		}
		this.lineTimeLimitMilliseconds = options.lineTimeLimitMilliseconds ?? 500;
		if (!Number.isSafeInteger(this.lineTimeLimitMilliseconds) || this.lineTimeLimitMilliseconds <= 0) {
			throw new RangeError("TextMate line time limit must be a positive safe integer");
		}
		this.scopeResolver = options.scopeResolver ?? defaultTextMateScopeResolver;
		if (typeof this.scopeResolver !== "function") {
			throw new TypeError("TextMate scope resolver must be a function");
		}
		this.onDidUpdateCache = options.onDidUpdateCache;
		if (this.onDidUpdateCache !== undefined && typeof this.onDidUpdateCache !== "function") {
			throw new TypeError("TextMate cache update observer must be a function");
		}
	}

	get languageIds(): readonly string[] {
		this.ensureAlive();
		return this.grammars.currentSnapshot.languageIds;
	}

	async tokenize(languageId: string, snapshot: TextSnapshot, signal: AbortSignal): Promise<LanguageTokenResult | undefined> {
		this.ensureAlive();
		signal.throwIfAborted();
		const grammarSnapshot = this.grammars.currentSnapshot;
		const definition = grammarSnapshot.getDefinitionForLanguage(languageId);
		if (!definition) return undefined;
		const state = this.acquireState(grammarSnapshot);
		try {
			const grammar = await this.getGrammar(state, definition.scopeName);
			signal.throwIfAborted();
			if (!grammar) throw new ReferenceError(`TextMate grammar '${definition.scopeName}' could not be loaded`);
			let cache = state.caches.get(languageId);
			if (!cache) {
				cache = new TextMateTokenizationCache(languageId, grammar, this.lineTimeLimitMilliseconds, createGrammarScopeResolver(definition, grammarSnapshot, this.scopeResolver), createGrammarMetadataResolver(definition, grammarSnapshot), this.onDidUpdateCache);
				state.caches.set(languageId, cache);
			}
			return cache.getTokens(snapshot, signal);
		} finally {
			this.releaseState(state);
		}
	}

	synchronizeDocument(synchronization: LanguageWorkerDocumentSynchronization): void {
		this.ensureAlive();
		if (synchronization.snapshot.version !== synchronization.modelVersion) {
			throw new Error("TextMate synchronization snapshot version is inconsistent");
		}
		for (const cache of this.currentState?.caches.values() ?? []) cache.synchronizeDocument(synchronization);
	}

	/** Discards semantic styles while retaining loaded grammars after a scope-theme replacement. */
	invalidateTokenCaches(): void {
		this.ensureAlive();
		this.currentState?.caches.clear();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.currentState) {
			this.currentState.retired = true;
			this.disposeStateWhenUnused(this.currentState);
			this.currentState = undefined;
		}
	}

	[Symbol.dispose](): void {
		this.dispose();
	}

	private acquireState(snapshot: TextMateGrammarRegistrySnapshot): TextMateRuntimeState {
		let state = this.currentState;
		if (!state || state.snapshot !== snapshot) {
			if (state) {
				state.retired = true;
				this.disposeStateWhenUnused(state);
			}
			state = createRuntimeState(snapshot, this.onigLib);
			this.currentState = state;
		}
		state.users += 1;
		return state;
	}

	private releaseState(state: TextMateRuntimeState): void {
		state.users -= 1;
		this.disposeStateWhenUnused(state);
	}

	private disposeStateWhenUnused(state: TextMateRuntimeState): void {
		if (!state.retired || state.users !== 0) return;
		state.caches.clear();
		state.grammars.clear();
		state.registry.dispose();
	}

	private getGrammar(state: TextMateRuntimeState, scopeName: string): Promise<IGrammar | undefined> {
		let grammar = state.grammars.get(scopeName);
		if (!grammar) {
			const definition = state.snapshot.getDefinitionForScope(scopeName);
			if (!definition?.languageId) return Promise.resolve(undefined);
			const configuration = createGrammarConfiguration(state.snapshot, definition, state.languageNumbers);
			const languageNumber = state.languageNumbers.get(definition.languageId);
			if (languageNumber === undefined) return Promise.resolve(undefined);
			grammar = state.registry.loadGrammarWithConfiguration(scopeName, languageNumber, configuration).then(value => value ?? undefined);
			state.grammars.set(scopeName, grammar);
		}
		return grammar;
	}

	private ensureAlive(): void {
		if (this.disposed) throw new ReferenceError("TextMateTokenizationService is already disposed");
	}
}

class TextMateTokenizationCache {
	private syntax: TextMateTokenizationDocument | undefined;

	constructor(
		private readonly languageId: string,
		private readonly grammar: IGrammar,
		private readonly lineTimeLimitMilliseconds: number,
		private readonly scopeResolver: TextMateScopeResolver,
		private readonly metadataResolver: TextMateScopeMetadataResolver,
		private readonly onDidUpdate: TextMateTokenizationServiceOptions["onDidUpdateCache"],
	) {}

	getTokens(snapshot: TextSnapshot, signal: AbortSignal): LanguageTokenResult {
		if (this.syntax?.version === snapshot.version) return this.syntax.tokens;
		const kind = this.syntax ? "incremental" : "full";
		this.syntax = this.update(snapshot, signal, kind);
		return this.syntax.tokens;
	}

	synchronizeDocument(synchronization: LanguageWorkerDocumentSynchronization): void {
		if (!this.syntax) return;
		if (this.syntax.version !== synchronization.previousVersion) {
			this.syntax = undefined;
			return;
		}
		this.syntax = this.update(synchronization.snapshot, undefined, "incremental");
	}

	private update(snapshot: TextSnapshot, signal: AbortSignal | undefined, kind: TextMateTokenizationCacheUpdate["kind"]): TextMateTokenizationDocument {
		const text = snapshot.getText();
		const lines = Object.freeze(text.split("\n"));
		if (text.length !== snapshot.length || lines.length !== snapshot.lineCount) {
			throw new Error("TextMate snapshot metadata is inconsistent");
		}
		const previous = kind === "incremental" ? this.syntax : undefined;
		const scanned = previous
			? updateLines(this.grammar, previous.lines, previous.lineResults, lines, this.lineTimeLimitMilliseconds, this.scopeResolver, this.metadataResolver, signal)
			: scanAllLines(this.grammar, lines, this.lineTimeLimitMilliseconds, this.scopeResolver, this.metadataResolver, signal);
		const syntax = Object.freeze({
			version: snapshot.version,
			lines,
			lineResults: scanned.lineResults,
			tokens: aggregateTokens(scanned.lineResults),
		});
		this.onDidUpdate?.(Object.freeze({
			modelVersion: snapshot.version,
			languageId: this.languageId,
			kind: previous ? "incremental" : "full",
			scannedLineCount: scanned.scannedLineCount,
			reusedLineCount: lines.length - scanned.scannedLineCount,
		}));
		return syntax;
	}
}

function createRuntimeState(snapshot: TextMateGrammarRegistrySnapshot, onigLib: Promise<IOnigLib>): TextMateRuntimeState {
	const registry = new Registry({
		onigLib,
		loadGrammar: async scopeName => {
			const definition = snapshot.getDefinitionForScope(scopeName);
			if (!definition) return undefined;
			return normalizeRawGrammar(await definition.loadGrammar(), definition.scopeName, definition.filePath);
		},
		getInjections: scopeName => [...snapshot.getInjections(scopeName)],
	});
	const languageNumbers = new Map<string, number>();
	for (const definition of snapshot.grammars) {
		if (definition.languageId) addLanguageNumber(languageNumbers, definition.languageId);
		for (const languageId of Object.values(definition.embeddedLanguages ?? {})) addLanguageNumber(languageNumbers, languageId);
	}
	return { snapshot, registry, languageNumbers, grammars: new Map(), caches: new Map(), users: 0, retired: false };
}

function addLanguageNumber(languageNumbers: Map<string, number>, languageId: string): void {
	if (languageNumbers.has(languageId)) return;
	languageNumbers.set(languageId, languageNumbers.size + 1);
}

function createGrammarConfiguration(snapshot: TextMateGrammarRegistrySnapshot, definition: RegisteredTextMateGrammarDefinition, languageNumbers: ReadonlyMap<string, number>): IGrammarConfiguration {
	const tokenTypes: Record<string, number> = {};
	const embeddedLanguages: Record<string, number> = {};
	for (const candidate of [definition, ...snapshot.getInjections(definition.scopeName).map(scope => snapshot.getDefinitionForScope(scope)).filter((value): value is RegisteredTextMateGrammarDefinition => value !== undefined)]) {
		for (const [scope, tokenType] of Object.entries(candidate.tokenTypes ?? {})) tokenTypes[scope] = standardTokenType(tokenType);
		for (const [scope, languageId] of Object.entries(candidate.embeddedLanguages ?? {})) {
			const languageNumber = languageNumbers.get(languageId);
			if (languageNumber !== undefined) embeddedLanguages[scope] = languageNumber;
		}
	}
	return {
		embeddedLanguages,
		tokenTypes,
		balancedBracketSelectors: [...(definition.balancedBracketScopes ?? ["*"])],
		unbalancedBracketSelectors: [...(definition.unbalancedBracketScopes ?? [])],
	};
}

function standardTokenType(value: TextMateGrammarTokenType): number {
	switch (value) {
		case "comment": return 1;
		case "string": return 2;
		case "regex": return 3;
		case "other": return 0;
	}
}

function createGrammarScopeResolver(definition: RegisteredTextMateGrammarDefinition, snapshot: TextMateGrammarRegistrySnapshot, fallback: TextMateScopeResolver): TextMateScopeResolver {
	const tokenTypes = new Map<string, TextMateGrammarTokenType>();
	for (const candidate of [definition, ...snapshot.getInjections(definition.scopeName).map(scope => snapshot.getDefinitionForScope(scope)).filter((value): value is RegisteredTextMateGrammarDefinition => value !== undefined)]) {
		for (const [scope, tokenType] of Object.entries(candidate.tokenTypes ?? {})) tokenTypes.set(scope, tokenType);
	}
	return scopes => {
		const override = resolveTokenTypeOverride(scopes, tokenTypes);
		if (override === undefined) return fallback(scopes);
		if (override === "other") return fallback(scopes);
		const style = fallback(scopes);
		return Object.freeze({ ...style, tokenType: override, modifiers: style?.modifiers ?? EMPTY_MODIFIERS });
	};
}

function createGrammarMetadataResolver(definition: RegisteredTextMateGrammarDefinition, snapshot: TextMateGrammarRegistrySnapshot): TextMateScopeMetadataResolver {
	const embeddedLanguages = new Map<string, string>();
	for (const candidate of grammarAndInjections(definition, snapshot)) {
		for (const [selector, languageId] of Object.entries(candidate.embeddedLanguages ?? {})) embeddedLanguages.set(selector, languageId);
	}
	const balanced = definition.balancedBracketScopes ?? ["*"];
	const unbalanced = definition.unbalancedBracketScopes ?? [];
	return scopes => {
		let embedded: { readonly selector: string; readonly languageId: string } | undefined;
		for (const [selector, languageId] of embeddedLanguages) {
			if (matchesScopeSelector(selector, scopes) && (!embedded || selector.length > embedded.selector.length)) embedded = { selector, languageId };
		}
		const canBalance = balanced.some(selector => matchesScopeSelector(selector, scopes)) && !unbalanced.some(selector => matchesScopeSelector(selector, scopes));
		return Object.freeze({ ...(embedded === undefined ? {} : { languageId: embedded.languageId }), ...(canBalance ? {} : { balancedBrackets: false as const }) });
	};
}

function grammarAndInjections(definition: RegisteredTextMateGrammarDefinition, snapshot: TextMateGrammarRegistrySnapshot): readonly RegisteredTextMateGrammarDefinition[] {
	return Object.freeze([definition, ...snapshot.getInjections(definition.scopeName).map(scope => snapshot.getDefinitionForScope(scope)).filter((value): value is RegisteredTextMateGrammarDefinition => value !== undefined)]);
}

function resolveTokenTypeOverride(scopes: readonly string[], tokenTypes: ReadonlyMap<string, TextMateGrammarTokenType>): string | undefined {
	let best: { readonly selector: string; readonly tokenType: TextMateGrammarTokenType } | undefined;
	for (const [selector, tokenType] of tokenTypes) {
		if (!matchesScopeSelector(selector, scopes)) continue;
		if (!best || selector.length > best.selector.length) best = { selector, tokenType };
	}
	if (!best) return undefined;
	switch (best.tokenType) {
		case "comment": return "comment";
		case "string": return "string";
		case "regex": return "regexp";
		case "other": return "other";
	}
}

function matchesScopeSelector(selector: string, scopes: readonly string[]): boolean {
	const clauses = selector.split(/\s+/u).filter(clause => clause.length > 0);
	if (clauses.length === 0) return false;
	let scopeIndex = 0;
	for (const clause of clauses) {
		const matchIndex = scopes.findIndex((scope, index) => index >= scopeIndex && matchesScope(clause, scope));
		if (matchIndex < 0) return false;
		scopeIndex = matchIndex + 1;
	}
	return true;
}

function matchesScope(selector: string, scope: string): boolean {
	if (selector === "*") return true;
	if (!selector.includes("*")) return scope === selector || scope.startsWith(`${selector}.`);
	const expression = selector.split("*").map(escapeRegExpCharacters).join("[^.]*");
	return new RegExp(`^${expression}(?:\\.|$)`, "u").test(scope);
}

const EMPTY_MODIFIERS: readonly string[] = Object.freeze([]);

function normalizeRawGrammar(content: TextMateGrammarContent, scopeName: string, filePath = `${scopeName}.tmLanguage.json`): IRawGrammar {
	const grammar = typeof content === "string" ? parseRawGrammar(content, filePath) : content;
	if (typeof grammar !== "object" || grammar === null || grammar.scopeName !== scopeName) {
		throw new TypeError(`TextMate grammar '${scopeName}' returned a different root scope`);
	}
	return grammar;
}

function scanAllLines(grammar: IGrammar, lines: readonly string[], timeLimit: number, resolver: TextMateScopeResolver, metadataResolver: TextMateScopeMetadataResolver, signal?: AbortSignal): { readonly lineResults: readonly TextMateLineResult[]; readonly scannedLineCount: number } {
	const lineResults: TextMateLineResult[] = [];
	let state = INITIAL;
	for (const line of lines) {
		signal?.throwIfAborted();
		const result = scanLine(grammar, line, state, timeLimit, resolver, metadataResolver);
		lineResults.push(result);
		state = result.outputState;
	}
	return { lineResults: Object.freeze(lineResults), scannedLineCount: lines.length };
}

function updateLines(grammar: IGrammar, previousLines: readonly string[], previousResults: readonly TextMateLineResult[], lines: readonly string[], timeLimit: number, resolver: TextMateScopeResolver, metadataResolver: TextMateScopeMetadataResolver, signal?: AbortSignal): { readonly lineResults: readonly TextMateLineResult[]; readonly scannedLineCount: number } {
	const prefixLength = commonPrefixLength(previousLines, lines);
	const suffixLength = commonArraySuffixLength(previousLines, lines, prefixLength);
	const lineResults = previousResults.slice(0, prefixLength);
	const newSuffixStart = lines.length - suffixLength;
	const oldSuffixStart = previousLines.length - suffixLength;
	let state = lineResults.at(-1)?.outputState ?? INITIAL;
	let scannedLineCount = 0;
	for (let lineIndex = prefixLength; lineIndex < lines.length; lineIndex += 1) {
		signal?.throwIfAborted();
		if (lineIndex >= newSuffixStart) {
			const oldIndex = oldSuffixStart + lineIndex - newSuffixStart;
			const cached = previousResults[oldIndex]!;
			if (cached.inputState.equals(state)) {
				lineResults.push(...previousResults.slice(oldIndex));
				break;
			}
		}
		const result = scanLine(grammar, lines[lineIndex]!, state, timeLimit, resolver, metadataResolver);
		lineResults.push(result);
		state = result.outputState;
		scannedLineCount += 1;
	}
	return { lineResults: Object.freeze(lineResults), scannedLineCount };
}

function scanLine(grammar: IGrammar, line: string, inputState: StateStack, timeLimit: number, resolver: TextMateScopeResolver, metadataResolver: TextMateScopeMetadataResolver): TextMateLineResult {
	const result = grammar.tokenizeLine(line, inputState, timeLimit);
	if (result.stoppedEarly) throw new Error("TextMate line tokenization exceeded its time limit");
	const tokens: TextMateRelativeToken[] = [];
	for (const token of result.tokens) {
		const startColumn = token.startIndex;
		const endColumn = Math.min(token.endIndex, line.length);
		if (!Number.isSafeInteger(startColumn) || !Number.isSafeInteger(endColumn) || startColumn < 0 || endColumn < startColumn || startColumn > line.length) {
			throw new RangeError("TextMate runtime returned an invalid token range");
		}
		if (endColumn === startColumn) continue;
		const scopes = Object.freeze([...token.scopes]);
		const metadata = metadataResolver(scopes);
		const style = resolver(scopes);
		if (!style && metadata.languageId === undefined && metadata.balancedBrackets !== false) continue;
		appendRelativeToken(tokens, startColumn, endColumn, style ? normalizeStyle(style) : Object.freeze({ tokenType: "source", modifiers: EMPTY_MODIFIERS }), metadata);
	}
	return Object.freeze({ inputState, outputState: result.ruleStack, tokens: Object.freeze(tokens) });
}

function normalizeStyle(style: TextMateResolvedTokenStyle): TextMateResolvedTokenStyle & { readonly tokenType: string; readonly modifiers: readonly string[] } {
	if (typeof style !== "object" || style === null || typeof style.tokenType !== "string" || style.tokenType.trim() !== style.tokenType || style.tokenType.length === 0) {
		throw new TypeError("TextMate scope resolver must return a non-empty token type");
	}
	if (!Array.isArray(style.modifiers ?? [])) throw new TypeError("TextMate token modifiers must be an array");
	const modifiers = [...(style.modifiers ?? [])];
	for (const modifier of modifiers) {
		if (typeof modifier !== "string" || modifier.trim() !== modifier || modifier.length === 0) {
			throw new TypeError("TextMate token modifier must be a non-empty trimmed string");
		}
	}
	if (new Set(modifiers).size !== modifiers.length) throw new RangeError("TextMate token modifiers must be unique");
	const foreground = style.foreground === undefined ? undefined : normalizeColor(style.foreground, "foreground");
	const background = style.background === undefined ? undefined : normalizeColor(style.background, "background");
	const fontStyle = style.fontStyle === undefined ? undefined : normalizeFontStyle(style.fontStyle);
	return Object.freeze({ tokenType: style.tokenType, modifiers: Object.freeze(modifiers), ...(foreground === undefined ? {} : { foreground }), ...(background === undefined ? {} : { background }), ...(fontStyle === undefined ? {} : { fontStyle }) });
}

function appendRelativeToken(tokens: TextMateRelativeToken[], startColumn: number, endColumn: number, style: TextMateResolvedTokenStyle & { readonly tokenType: string; readonly modifiers: readonly string[] }, metadata: TextMateScopeMetadata): void {
	const presentation = style.foreground === undefined && style.background === undefined && style.fontStyle === undefined ? undefined : Object.freeze({ ...(style.foreground === undefined ? {} : { foreground: style.foreground }), ...(style.background === undefined ? {} : { background: style.background }), ...(style.fontStyle === undefined ? {} : { fontStyle: style.fontStyle }) });
	const previous = tokens.at(-1);
	if (previous && previous.endColumn === startColumn && previous.tokenType === style.tokenType && arraysEqual(previous.modifiers, style.modifiers) && previous.languageId === metadata.languageId && previous.balancedBrackets === metadata.balancedBrackets && presentationsEqual(previous.presentation, presentation)) {
		tokens[tokens.length - 1] = Object.freeze({ ...previous, endColumn });
		return;
	}
	tokens.push(Object.freeze({ startColumn, endColumn, tokenType: style.tokenType, modifiers: style.modifiers, ...(metadata.languageId === undefined ? {} : { languageId: metadata.languageId }), ...(metadata.balancedBrackets === undefined ? {} : { balancedBrackets: metadata.balancedBrackets }), ...(presentation === undefined ? {} : { presentation }) }));
}

function aggregateTokens(lineResults: readonly TextMateLineResult[]): LanguageTokenResult {
	const tokens: LanguageToken[] = [];
	for (let lineIndex = 0; lineIndex < lineResults.length; lineIndex += 1) {
		for (const token of lineResults[lineIndex]!.tokens) {
			tokens.push(Object.freeze({
				range: Range.fromPositions(new Position((lineIndex) + 1, (token.startColumn) + 1), new Position((lineIndex) + 1, (token.endColumn) + 1)),
				tokenType: token.tokenType,
				modifiers: token.modifiers,
				...(token.languageId === undefined ? {} : { languageId: token.languageId }),
				...(token.balancedBrackets === undefined ? {} : { balancedBrackets: token.balancedBrackets }),
				...(token.presentation === undefined ? {} : { presentation: token.presentation }),
			}));
		}
	}
	return Object.freeze({ tokens: Object.freeze(tokens) });
}

function normalizeColor(value: unknown, kind: string): string {
	if (typeof value !== "string" || !/^#[0-9a-f]{3,4}(?:[0-9a-f]{3,4})?$/iu.test(value)) throw new TypeError(`TextMate token ${kind} must be a hexadecimal color`);
	return value;
}

function normalizeFontStyle(value: readonly string[]): readonly ("italic" | "bold" | "underline" | "strikethrough")[] {
	if (!Array.isArray(value)) throw new TypeError("TextMate token font style must be an array");
	const styles = value.map(style => {
		if (style !== "italic" && style !== "bold" && style !== "underline" && style !== "strikethrough") throw new TypeError(`Unsupported TextMate token font style '${String(style)}'`);
		return style;
	});
	if (new Set(styles).size !== styles.length) throw new RangeError("TextMate token font styles must be unique");
	return Object.freeze(styles);
}

function presentationsEqual(left: LanguageToken["presentation"], right: LanguageToken["presentation"]): boolean {
	return left?.foreground === right?.foreground && left?.background === right?.background && arraysEqual(left?.fontStyle ?? [], right?.fontStyle ?? []);
}
