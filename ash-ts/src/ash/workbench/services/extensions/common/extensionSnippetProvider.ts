import { parseSnippet } from "../../../../editor/contrib/snippet/common/snippetParser.js";
import { LanguageCompletionItemKind, LanguageCompletionInsertTextFormat } from "../../../../editor/common/languages/completion/languageCompletions.js";
import type { LanguageCompletionProvider, LanguageCompletionProviderRequest, LanguageCompletionProviderResult } from "../../../../editor/common/languages/completion/languageCompletionProviders.js";
import { Position } from "../../../../editor/common/core/position.js";
import { Range } from "../../../../editor/common/core/range.js";

export interface ExtensionSnippetDefinition {
	readonly name: string;
	readonly prefixes: readonly string[];
	readonly body: string;
	readonly description?: string;
	readonly scopes?: readonly string[];
	readonly isFileTemplate?: boolean;
}

/** Expands one file-template snippet to the initial text of an untitled editor. */
export function materializeExtensionFileTemplate(snippet: ExtensionSnippetDefinition): string {
	if (!snippet.isFileTemplate) throw new TypeError("Extension file template must declare isFileTemplate");
	return parseSnippet(snippet.body, { allowUnresolvedVariables: true }).text;
}

/** Parses the VS Code declarative snippet-file shape without executing extension code. */
export function parseExtensionSnippetFile(value: unknown, owner: string): readonly ExtensionSnippetDefinition[] {
	const snippets = record(value, owner);
	return Object.entries(snippets).map(([name, candidate]) => {
		const snippet = record(candidate, `${owner}.${name}`);
		const isFileTemplate = snippet.isFileTemplate === undefined ? false : booleanValue(snippet.isFileTemplate, `${owner}.${name}.isFileTemplate`);
		const prefixes = parsePrefixes(snippet.prefix, `${owner}.${name}.prefix`, isFileTemplate);
		const body = typeof snippet.body === "string"
			? snippet.body
			: parseBody(snippet.body, `${owner}.${name}.body`);
		if (body.length > 1024 * 1024) throw new RangeError(`${owner}.${name}.body is too large`);
		parseSnippet(body, { allowUnresolvedVariables: true });
		const description = snippet.description === undefined ? undefined : boundedText(snippet.description, `${owner}.${name}.description`, 512);
		const scopes = snippet.scope === undefined ? undefined : parseScopes(snippet.scope, `${owner}.${name}.scope`);
		return Object.freeze({
			name: boundedText(name, `${owner} snippet name`, 256),
			prefixes: Object.freeze(prefixes),
			body,
			...(description === undefined ? {} : { description }),
			...(scopes === undefined ? {} : { scopes }),
			...(isFileTemplate ? { isFileTemplate: true } : {}),
		});
	});
}

/** Creates a language completion provider for one extension snippet contribution. */
export function createExtensionSnippetProvider(id: string, languageId: string, snippets: readonly ExtensionSnippetDefinition[]): LanguageCompletionProvider {
	const completableSnippets = snippets.filter(snippet => snippet.prefixes.length > 0);
	if (!Array.isArray(snippets) || completableSnippets.length === 0) throw new TypeError("Extension snippet provider requires prefixed snippets");
	return Object.freeze({
		id,
		languageIds: Object.freeze([languageId]),
		provideCompletions: (request: LanguageCompletionProviderRequest, signal: AbortSignal): LanguageCompletionProviderResult | undefined => {
			signal.throwIfAborted();
			const line = request.snapshot.getText().split("\n")[request.position.lineNumber - 1];
			if (line === undefined || request.position.column < 1 || request.position.column > line.length + 1) throw new RangeError("Snippet completion position is outside its snapshot");
			const prefix = readPrefix(line, request.position.column - 1);
			if (prefix.length === 0) return undefined;
			const range = Range.fromPositions(
				new Position(request.position.lineNumber, request.position.column - prefix.length),
				request.position,
			);
			const items = completableSnippets
				.filter(snippet => !snippet.scopes || snippet.scopes.includes(languageId))
				.filter(snippet => snippet.prefixes.some((candidate: string) => candidate.toLowerCase().startsWith(prefix.toLowerCase())))
				.map((snippet, index) => Object.freeze({
					id: `${id}.${index}`,
					label: snippet.prefixes[0]!,
					kind: LanguageCompletionItemKind.Snippet,
					range,
					insertText: snippet.body,
					insertTextFormat: LanguageCompletionInsertTextFormat.Snippet,
					...(snippet.description === undefined ? {} : { detail: snippet.description }),
					sortText: snippet.prefixes[0]!,
				}))
				.slice(0, 100);
			if (items.length === 0) return undefined;
			return Object.freeze({ items: Object.freeze(items), isIncomplete: false });
		},
	});
}

function readPrefix(line: string, column: number): string {
	let start = column;
	while (start > 0 && /[A-Za-z0-9_.-]/u.test(line[start - 1]!)) start -= 1;
	return line.slice(start, column);
}

function parsePrefixes(value: unknown, owner: string, allowEmpty: boolean): readonly string[] {
	if (value === undefined && allowEmpty) return Object.freeze([]);
	const prefixes = typeof value === "string" ? [value] : parseTextList(value, owner, 128);
	if (prefixes.length === 0 || prefixes.some(prefix => prefix.length === 0)) throw new TypeError(`${owner} must contain a prefix`);
	return prefixes;
}

function booleanValue(value: unknown, owner: string): boolean {
	if (typeof value !== "boolean") throw new TypeError(`${owner} must be a boolean`);
	return value;
}

function parseBody(value: unknown, owner: string): string {
	const lines = parseTextList(value, owner, 1024 * 1024, false);
	return lines.join("\n");
}

function parseScopes(value: unknown, owner: string): readonly string[] {
	const scopes = typeof value === "string" ? [value] : parseTextList(value, owner, 128);
	if (scopes.length === 0) throw new TypeError(`${owner} must contain a language scope`);
	return Object.freeze(scopes);
}

function parseTextList(value: unknown, owner: string, maximum: number, requireUnique = true): readonly string[] {
	if (!Array.isArray(value)) throw new TypeError(`${owner} must be a string array`);
	const values = value.map(candidate => boundedText(candidate, owner, maximum));
	if (requireUnique && new Set(values).size !== values.length) throw new RangeError(`${owner} must be unique`);
	return values;
}

function boundedText(value: unknown, owner: string, maximum: number): string {
	if (typeof value !== "string" || value.length > maximum || /[\r\n]/u.test(value)) throw new TypeError(`${owner} must be bounded text`);
	return value;
}

function record(value: unknown, owner: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${owner} must be an object`);
	return value as Record<string, unknown>;
}
