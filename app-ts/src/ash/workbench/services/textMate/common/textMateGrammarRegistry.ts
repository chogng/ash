import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, toDisposable, type IDisposable } from "../../../../base/common/lifecycle.js";
import { assertLanguageId } from '../../../../editor/common/languages/language.js';
import { type IRawGrammar } from "vscode-textmate";

export type TextMateGrammarContent = string | IRawGrammar;
export type TextMateGrammarLoader = () => TextMateGrammarContent | PromiseLike<TextMateGrammarContent>;
export type TextMateGrammarTokenType = "string" | "other" | "comment" | "regex";

export interface TextMateGrammarDefinition {
	readonly scopeName: string;
	readonly languageId?: string;
	readonly injectTo?: readonly string[];
	readonly embeddedLanguages?: Readonly<Record<string, string>>;
	readonly tokenTypes?: Readonly<Record<string, TextMateGrammarTokenType>>;
	readonly balancedBracketScopes?: readonly string[];
	readonly unbalancedBracketScopes?: readonly string[];
	readonly filePath?: string;
	loadGrammar(): TextMateGrammarContent | PromiseLike<TextMateGrammarContent>;
}

export interface RegisteredTextMateGrammarDefinition {
	readonly scopeName: string;
	readonly languageId?: string;
	readonly injectTo: readonly string[];
	readonly embeddedLanguages?: Readonly<Record<string, string>>;
	readonly tokenTypes?: Readonly<Record<string, TextMateGrammarTokenType>>;
	readonly balancedBracketScopes?: readonly string[];
	readonly unbalancedBracketScopes?: readonly string[];
	readonly filePath: string;
	loadGrammar(): TextMateGrammarContent | PromiseLike<TextMateGrammarContent>;
}

export interface TextMateGrammarRegistrySnapshot {
	readonly revision: number;
	readonly languageIds: readonly string[];
	readonly grammars: readonly RegisteredTextMateGrammarDefinition[];
	getDefinitionForLanguage(languageId: string): RegisteredTextMateGrammarDefinition | undefined;
	getDefinitionForScope(scopeName: string): RegisteredTextMateGrammarDefinition | undefined;
	getInjections(scopeName: string): readonly string[];
}

/** One replaceable, caller-owned group of TextMate grammar contributions. */
export interface TextMateGrammarRegistration extends IDisposable {
	readonly currentSnapshot: TextMateGrammarRegistrySnapshot;
	owns(snapshot: TextMateGrammarRegistrySnapshot): boolean;
	prepare(definitions: readonly TextMateGrammarDefinition[]): PreparedTextMateGrammarReplacement;
	replace(definitions: readonly TextMateGrammarDefinition[]): void;
}

/** A validated replacement bound to the registry revision on which it was prepared. */
export interface PreparedTextMateGrammarReplacement {
	readonly snapshot: TextMateGrammarRegistrySnapshot;
	commit(): void;
}

/** Caller-owned TextMate grammar contributions with immutable revision snapshots. */
export class TextMateGrammarRegistry extends Disposable {
	private readonly changeEmitter = this._register(new Emitter<TextMateGrammarRegistrySnapshot>());
	private readonly groups = new Map<object, readonly RegisteredTextMateGrammarDefinition[]>();
	private snapshot: TextMateGrammarRegistrySnapshot = createSnapshot(0, []);

	readonly onDidChange: Event<TextMateGrammarRegistrySnapshot> = this.changeEmitter.event;

	constructor() {
		super();
		this._register(toDisposable(() => {
			const changed = this.groups.size > 0;
			this.groups.clear();
			if (changed) this.publish();
		}));
	}

	get currentSnapshot(): TextMateGrammarRegistrySnapshot {
		this.assertNotDisposed();
		return this.snapshot;
	}

	register(definition: TextMateGrammarDefinition): IDisposable {
		return this.registerMany([definition]);
	}

	/** Registers a group that can later be replaced without colliding with its previous definitions. */
	registerMany(definitions: readonly TextMateGrammarDefinition[]): TextMateGrammarRegistration {
		this.assertNotDisposed();
		const key = Object.freeze({});
		const registered = normalizeDefinitions(definitions);
		this.validateReplacement(key, registered);
		if (registered.length > 0) {
			this.groups.set(key, registered);
			this.publish();
		}
		let disposed = false;
		const dispose = (): void => {
			if (disposed) return;
			disposed = true;
			if (this.groups.delete(key) && !this.isDisposed) this.publish();
		};
		const registration = toDisposable(dispose) as TextMateGrammarRegistration;
		Object.defineProperty(registration, "currentSnapshot", { enumerable: true, get: () => this.snapshot });
		registration.owns = snapshot => snapshot === this.snapshot;
		registration.prepare = (nextDefinitions): PreparedTextMateGrammarReplacement => {
			if (disposed) throw new ReferenceError("TextMate grammar registration is already disposed");
			this.assertNotDisposed();
			const next = normalizeDefinitions(nextDefinitions);
			this.validateReplacement(key, next);
			const baseRevision = this.snapshot.revision;
			const snapshot = createSnapshot(baseRevision + 1, this.replacementValues(key, next));
			let committed = false;
			return Object.freeze({
				snapshot,
				commit: (): void => {
					if (committed) throw new ReferenceError("Prepared TextMate grammar replacement is already committed");
					if (disposed) throw new ReferenceError("TextMate grammar registration is already disposed");
					this.assertNotDisposed();
					if (this.snapshot.revision !== baseRevision) throw new Error("TextMate grammar registry changed after replacement preparation");
					this.validateReplacement(key, next);
					committed = true;
					if (next.length === 0) this.groups.delete(key);
					else this.groups.set(key, next);
					this.publish();
				},
			});
		};
		registration.replace = (nextDefinitions): void => registration.prepare(nextDefinitions).commit();
		return registration;
	}

	private publish(): void {
		this.snapshot = createSnapshot(this.snapshot.revision + 1, [...this.groups.values()].flat());
		this.changeEmitter.fire(this.snapshot);
	}

	private validateReplacement(key: object, replacement: readonly RegisteredTextMateGrammarDefinition[]): void {
		const definitions = this.replacementValues(key, replacement);
		const scopes = new Set<string>();
		const languages = new Set<string>();
		for (const definition of definitions) {
			if (scopes.has(definition.scopeName)) throw new RangeError(`TextMate grammar scope '${definition.scopeName}' is already registered`);
			scopes.add(definition.scopeName);
			if (definition.languageId === undefined) continue;
			if (languages.has(definition.languageId)) throw new RangeError(`TextMate language '${definition.languageId}' already has a root grammar`);
			languages.add(definition.languageId);
		}
	}

	private replacementValues(key: object, replacement: readonly RegisteredTextMateGrammarDefinition[]): readonly RegisteredTextMateGrammarDefinition[] {
		const definitions: RegisteredTextMateGrammarDefinition[] = [];
		let replaced = false;
		for (const [candidate, values] of this.groups) {
			if (candidate === key) {
				definitions.push(...replacement);
				replaced = true;
			} else {
				definitions.push(...values);
			}
		}
		if (!replaced) definitions.push(...replacement);
		return definitions;
	}

}

function normalizeDefinitions(definitions: readonly TextMateGrammarDefinition[]): readonly RegisteredTextMateGrammarDefinition[] {
	if (!Array.isArray(definitions)) throw new TypeError("TextMate grammar definitions must be an array");
	return Object.freeze(definitions.map(normalizeDefinition));
}

function normalizeDefinition(definition: TextMateGrammarDefinition): RegisteredTextMateGrammarDefinition {
	if (typeof definition !== "object" || definition === null) {
		throw new TypeError("TextMate grammar definition must be an object");
	}
	assertScopeName(definition.scopeName, "TextMate grammar scope");
	if (definition.languageId !== undefined) assertLanguageId(definition.languageId);
	if (!Array.isArray(definition.injectTo ?? [])) {
		throw new TypeError("TextMate grammar injection targets must be an array");
	}
	const injectTo = [...(definition.injectTo ?? [])];
	for (const scopeName of injectTo) assertScopeName(scopeName, "TextMate grammar injection target");
	if (new Set(injectTo).size !== injectTo.length) {
		throw new RangeError("TextMate grammar injection targets must be unique");
	}
	const embeddedLanguages = definition.embeddedLanguages === undefined ? undefined : normalizeEmbeddedLanguages(definition.embeddedLanguages);
	const tokenTypes = definition.tokenTypes === undefined ? undefined : normalizeTokenTypes(definition.tokenTypes);
	const balancedBracketScopes = definition.balancedBracketScopes === undefined ? undefined : normalizeBracketScopes(definition.balancedBracketScopes, "balanced bracket scopes");
	const unbalancedBracketScopes = definition.unbalancedBracketScopes === undefined ? undefined : normalizeBracketScopes(definition.unbalancedBracketScopes, "unbalanced bracket scopes");
	if (typeof definition.loadGrammar !== "function") {
		throw new TypeError("TextMate grammar definition must implement loadGrammar");
	}
	const filePath = definition.filePath ?? `${definition.scopeName}.tmLanguage.json`;
	assertGrammarFilePath(filePath);
	return Object.freeze({
		scopeName: definition.scopeName,
		...(definition.languageId === undefined ? {} : { languageId: definition.languageId }),
		injectTo: Object.freeze(injectTo),
		...(embeddedLanguages === undefined ? {} : { embeddedLanguages }),
		...(tokenTypes === undefined ? {} : { tokenTypes }),
		...(balancedBracketScopes === undefined ? {} : { balancedBracketScopes }),
		...(unbalancedBracketScopes === undefined ? {} : { unbalancedBracketScopes }),
		filePath,
		loadGrammar: definition.loadGrammar.bind(definition),
	});
}

function createSnapshot(revision: number, values: readonly RegisteredTextMateGrammarDefinition[]): TextMateGrammarRegistrySnapshot {
	const grammars = Object.freeze([...values]);
	const definitionsByScope = new Map(grammars.map(definition => [definition.scopeName, definition]));
	const definitionsByLanguage = new Map(grammars.flatMap(definition => definition.languageId ? [[definition.languageId, definition] as const] : []));
	const injections = new Map<string, string[]>();
	for (const definition of values) {
		for (const scopeName of definition.injectTo) {
			const scopes = injections.get(scopeName) ?? [];
			scopes.push(definition.scopeName);
			injections.set(scopeName, scopes);
		}
	}
	const languageIds = Object.freeze([...definitionsByLanguage.keys()]);
	return Object.freeze({
		revision,
		languageIds,
		grammars,
		getDefinitionForLanguage: (languageId: string) => {
			assertLanguageId(languageId);
			return definitionsByLanguage.get(languageId);
		},
		getDefinitionForScope: (scopeName: string) => {
			assertScopeName(scopeName, "TextMate grammar scope");
			return definitionsByScope.get(scopeName);
		},
		getInjections: (scopeName: string) => {
			assertScopeName(scopeName, "TextMate grammar scope");
			return Object.freeze([...(injections.get(scopeName) ?? [])]);
		},
	});
}

function assertScopeName(value: unknown, owner: string): asserts value is string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)) {
		throw new TypeError(`${owner} must contain only letters, digits, dot, underscore, plus, or hyphen`);
	}
}

function assertGrammarFilePath(value: unknown): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 1024 || value.includes("\\") || value.startsWith("/") || value.split("/").some(segment => segment.length === 0 || segment === "." || segment === "..")) {
		throw new TypeError("TextMate grammar file path must be a safe relative path");
	}
}

function normalizeEmbeddedLanguages(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
	const entries = normalizeRecord(value, "TextMate embedded languages");
	return Object.freeze(Object.fromEntries(entries.map(([scope, languageId]) => [
		assertScopeKey(scope, "TextMate embedded language scope"),
		assertLanguageValue(languageId, "TextMate embedded language"),
	])));
}

function normalizeTokenTypes(value: Readonly<Record<string, TextMateGrammarTokenType>>): Readonly<Record<string, TextMateGrammarTokenType>> {
	const entries = normalizeRecord(value, "TextMate token types");
	return Object.freeze(Object.fromEntries(entries.map(([scope, tokenType]) => {
		const normalizedScope = assertScopeSelector(scope, "TextMate token type scope");
		if (tokenType !== "string" && tokenType !== "other" && tokenType !== "comment" && tokenType !== "regex") {
			throw new TypeError(`TextMate token type '${String(tokenType)}' is invalid`);
		}
		return [normalizedScope, tokenType as TextMateGrammarTokenType] as const;
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

function assertScopeKey(value: string, owner: string): string {
	assertScopeName(value, owner);
	return value;
}

function assertScopeSelector(value: string, owner: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\r\n]/u.test(value) || value.trim() !== value) {
		throw new TypeError(`${owner} must be a valid TextMate scope selector`);
	}
	return value;
}

function assertLanguageValue(value: unknown, owner: string): string {
	if (typeof value !== "string") throw new TypeError(`${owner} must map to a language ID`);
	assertLanguageId(value);
	return value;
}
