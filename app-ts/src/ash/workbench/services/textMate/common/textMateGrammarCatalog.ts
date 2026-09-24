import { raceCancellationError } from "../../../../base/common/async.js";
import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { assertLanguageId } from '../../../../editor/common/languages/language.js';
import { type TextMateGrammarRegistrySnapshot, type TextMateGrammarTokenType } from "./textMateGrammarRegistry.js";
import * as textMateNamespace from "vscode-textmate";

const textMateRuntime = (textMateNamespace as unknown as { readonly default?: typeof textMateNamespace }).default ?? textMateNamespace;
const { parseRawGrammar } = textMateRuntime;

export interface TextMateGrammarCatalogEntry {
	readonly scopeName: string;
	readonly languageId?: string;
	readonly injectTo: readonly string[];
	readonly embeddedLanguages?: Readonly<Record<string, string>>;
	readonly tokenTypes?: Readonly<Record<string, TextMateGrammarTokenType>>;
	readonly balancedBracketScopes?: readonly string[];
	readonly unbalancedBracketScopes?: readonly string[];
	readonly filePath?: string;
	readonly content: string;
}

export interface TextMateGrammarCatalog {
	readonly revision: number;
	readonly grammars: readonly TextMateGrammarCatalogEntry[];
}

export interface TextMateGrammarCatalogSource {
	readonly currentCatalog: TextMateGrammarCatalog;
	readonly onDidChangeCatalog: Event<TextMateGrammarCatalog>;
}

/** Mutable renderer-side source for complete versioned grammar catalogs. */
export class TextMateGrammarCatalogModel extends Disposable implements TextMateGrammarCatalogSource {
	private readonly changeEmitter = this._register(new Emitter<TextMateGrammarCatalog>());
	private catalog: TextMateGrammarCatalog;

	readonly onDidChangeCatalog: Event<TextMateGrammarCatalog> = this.changeEmitter.event;

	constructor(initialCatalog: TextMateGrammarCatalog = EMPTY_TEXTMATE_GRAMMAR_CATALOG) {
		super();
		this.catalog = normalizeTextMateGrammarCatalog(initialCatalog);
	}

	get currentCatalog(): TextMateGrammarCatalog {
		this.assertNotDisposed();
		return this.catalog;
	}

	replace(catalog: TextMateGrammarCatalog): void {
		this.assertNotDisposed();
		const normalized = normalizeTextMateGrammarCatalog(catalog);
		if (normalized.revision <= this.catalog.revision) {
			throw new RangeError("TextMate grammar catalog revision must increase");
		}
		this.catalog = normalized;
		this.changeEmitter.fire(normalized);
	}

}

export function normalizeTextMateGrammarCatalog(value: TextMateGrammarCatalog): TextMateGrammarCatalog {
	if (typeof value !== "object" || value === null) {
		throw new TypeError("TextMate grammar catalog must be an object");
	}
	if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
		throw new RangeError("TextMate grammar catalog revision must be a non-negative safe integer");
	}
	if (!Array.isArray(value.grammars)) {
		throw new TypeError("TextMate grammar catalog must contain grammars");
	}
	if (value.grammars.length > MAX_GRAMMAR_COUNT) {
		throw new RangeError(`TextMate grammar catalog cannot exceed ${MAX_GRAMMAR_COUNT} grammars`);
	}
	if (value.revision === 0 && value.grammars.length !== 0) {
		throw new RangeError("TextMate grammar catalog revision zero must be empty");
	}
	const scopes = new Set<string>();
	const languages = new Set<string>();
	let totalLength = 0;
	const grammars = value.grammars.map(grammar => {
		if (typeof grammar !== "object" || grammar === null) {
			throw new TypeError("TextMate grammar catalog entry must be an object");
		}
		assertScopeName(grammar.scopeName, "TextMate grammar catalog scope");
		if (scopes.has(grammar.scopeName)) throw new RangeError(`Duplicate TextMate grammar scope '${grammar.scopeName}'`);
		scopes.add(grammar.scopeName);
		if (grammar.languageId !== undefined) {
			assertLanguageId(grammar.languageId);
			if (languages.has(grammar.languageId)) throw new RangeError(`Duplicate TextMate root language '${grammar.languageId}'`);
			languages.add(grammar.languageId);
		}
		if (!Array.isArray(grammar.injectTo)) {
			throw new TypeError("TextMate grammar catalog injection targets must be an array");
		}
		const injectTo = [...grammar.injectTo];
		for (const scopeName of injectTo) assertScopeName(scopeName, "TextMate grammar catalog injection target");
		if (new Set(injectTo).size !== injectTo.length) {
			throw new RangeError("TextMate grammar catalog injection targets must be unique");
		}
		const embeddedLanguages = grammar.embeddedLanguages === undefined ? undefined : normalizeEmbeddedLanguages(grammar.embeddedLanguages);
		const tokenTypes = grammar.tokenTypes === undefined ? undefined : normalizeTokenTypes(grammar.tokenTypes);
		const balancedBracketScopes = grammar.balancedBracketScopes === undefined ? undefined : normalizeBracketScopes(grammar.balancedBracketScopes, "balanced bracket scopes");
		const unbalancedBracketScopes = grammar.unbalancedBracketScopes === undefined ? undefined : normalizeBracketScopes(grammar.unbalancedBracketScopes, "unbalanced bracket scopes");
		const filePath = grammar.filePath === undefined ? undefined : normalizeGrammarFilePath(grammar.filePath);
		if (typeof grammar.content !== "string" || grammar.content.length === 0) {
			throw new TypeError("TextMate grammar catalog content must not be empty");
		}
		if (grammar.content.length > MAX_GRAMMAR_LENGTH) {
			throw new RangeError(`TextMate grammar content cannot exceed ${MAX_GRAMMAR_LENGTH} UTF-16 units`);
		}
		totalLength += grammar.content.length;
		if (totalLength > MAX_CATALOG_LENGTH) {
			throw new RangeError(`TextMate grammar catalog cannot exceed ${MAX_CATALOG_LENGTH} UTF-16 units`);
		}
		return Object.freeze({
			scopeName: grammar.scopeName,
			...(grammar.languageId === undefined ? {} : { languageId: grammar.languageId }),
			injectTo: Object.freeze(injectTo),
			...(embeddedLanguages === undefined ? {} : { embeddedLanguages }),
			...(tokenTypes === undefined ? {} : { tokenTypes }),
			...(balancedBracketScopes === undefined ? {} : { balancedBracketScopes }),
			...(unbalancedBracketScopes === undefined ? {} : { unbalancedBracketScopes }),
			...(filePath === undefined ? {} : { filePath }),
			content: grammar.content,
		});
	});
	return Object.freeze({ revision: value.revision, grammars: Object.freeze(grammars) });
}

export async function materializeTextMateGrammarCatalog(snapshot: TextMateGrammarRegistrySnapshot, revision: number, signal: AbortSignal): Promise<TextMateGrammarCatalog> {
	if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.grammars)) {
		throw new TypeError("TextMate grammar materialization requires a registry snapshot");
	}
	if (!Number.isSafeInteger(revision) || revision <= 0) {
		throw new RangeError("Materialized TextMate grammar catalog revision must be a positive safe integer");
	}
	signal.throwIfAborted();
	const loading = Promise.all(snapshot.grammars.map(async definition => {
		const loaded = await definition.loadGrammar();
		signal.throwIfAborted();
		const grammar = typeof loaded === "string" ? parseRawGrammar(loaded, definition.filePath) : loaded;
		if (grammar.scopeName !== definition.scopeName) {
			throw new TypeError(`TextMate grammar '${definition.scopeName}' returned a different root scope`);
		}
		const content = typeof loaded === "string" ? loaded : JSON.stringify(loaded);
		return {
			scopeName: definition.scopeName,
			...(definition.languageId === undefined ? {} : { languageId: definition.languageId }),
			injectTo: definition.injectTo,
			...(definition.embeddedLanguages === undefined ? {} : { embeddedLanguages: definition.embeddedLanguages }),
			...(definition.tokenTypes === undefined ? {} : { tokenTypes: definition.tokenTypes }),
			...(definition.balancedBracketScopes === undefined ? {} : { balancedBracketScopes: definition.balancedBracketScopes }),
			...(definition.unbalancedBracketScopes === undefined ? {} : { unbalancedBracketScopes: definition.unbalancedBracketScopes }),
			filePath: definition.filePath,
			content,
		};
	}));
	const grammars = await raceCancellationError(loading, signal, "TextMate grammar materialization was cancelled");
	return normalizeTextMateGrammarCatalog({ revision, grammars });
}

export const EMPTY_TEXTMATE_GRAMMAR_CATALOG: TextMateGrammarCatalog = Object.freeze({
	revision: 0,
	grammars: Object.freeze([]),
});

const MAX_GRAMMAR_COUNT = 256;
const MAX_GRAMMAR_LENGTH = 4 * 1024 * 1024;
const MAX_CATALOG_LENGTH = 32 * 1024 * 1024;

function assertScopeName(value: unknown, owner: string): asserts value is string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)) {
		throw new TypeError(`${owner} is invalid`);
	}
}

function normalizeGrammarFilePath(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 1024 || value.includes("\\") || value.startsWith("/") || value.split("/").some(segment => segment.length === 0 || segment === "." || segment === "..")) {
		throw new TypeError("TextMate grammar catalog file path must be a safe relative path");
	}
	return value;
}

function normalizeEmbeddedLanguages(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
	const entries = normalizeRecord(value, "TextMate embedded languages");
	return Object.freeze(Object.fromEntries(entries.map(([scope, languageId]) => {
		assertScopeName(scope, "TextMate embedded language scope");
		assertLanguageId(languageId);
		return [scope, languageId];
	})));
}

function normalizeTokenTypes(value: Readonly<Record<string, TextMateGrammarTokenType>>): Readonly<Record<string, TextMateGrammarTokenType>> {
	const entries = normalizeRecord(value, "TextMate token types");
	return Object.freeze(Object.fromEntries(entries.map(([scope, tokenType]) => {
		assertScopeSelector(scope, "TextMate token type scope");
		if (tokenType !== "string" && tokenType !== "other" && tokenType !== "comment" && tokenType !== "regex") {
			throw new TypeError(`TextMate token type '${String(tokenType)}' is invalid`);
		}
		return [scope, tokenType as TextMateGrammarTokenType] as const;
	})) as Readonly<Record<string, TextMateGrammarTokenType>>);
}

function normalizeBracketScopes(value: readonly string[], owner: string): readonly string[] {
	if (!Array.isArray(value)) throw new TypeError(`TextMate ${owner} must be an array`);
	const scopes = value.map(scope => {
		if (typeof scope !== "string" || scope.length === 0 || scope.length > 256 || /[\r\n\s]/u.test(scope) || !/^[A-Za-z0-9*][A-Za-z0-9._+*?-]*$/u.test(scope)) {
			throw new TypeError(`TextMate ${owner} contain invalid scope selectors`);
		}
		return scope;
	});
	if (new Set(scopes).size !== scopes.length) throw new RangeError(`TextMate ${owner} must be unique`);
	return Object.freeze(scopes);
}

function normalizeRecord(value: unknown, owner: string): readonly (readonly [string, unknown])[] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${owner} must be an object map`);
	return Object.entries(value as Record<string, unknown>);
}

function assertScopeSelector(value: string, owner: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\r\n]/u.test(value) || value.trim() !== value) {
		throw new TypeError(`${owner} must be a valid TextMate scope selector`);
	}
	return value;
}
