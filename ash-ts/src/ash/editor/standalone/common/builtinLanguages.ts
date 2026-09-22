import { LanguagesRegistry, type LanguageDescription } from '../../common/services/languagesRegistry.js';
import { DisposableStore, type IDisposable } from '../../../base/common/lifecycle.js';
import { IndentAction, type CharacterPair, type FoldingMarkers, type IAutoClosingPairConditional, type IndentationRule, type LanguageConfiguration, type OnEnterRule } from '../../common/languages/languageConfiguration.js';
import type { ILanguageConfigurationService } from '../../common/languages/languageConfigurationRegistry.js';

const ECMASCRIPT_LANGUAGE_IDS = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact']);
const BRACKETS: CharacterPair[] = [
	['(', ')'],
	['[', ']'],
	['{', '}'],
];
const JSON_BRACKETS: CharacterPair[] = [BRACKETS[1]!, BRACKETS[2]!];
const ECMASCRIPT_PAIRS: IAutoClosingPairConditional[] = [
	...pairsFromBrackets(BRACKETS),
	autoPair("'", "'", ['string', 'comment']),
	autoPair('"', '"', ['string']),
	autoPair('`', '`', ['string', 'comment']),
];
const JSON_PAIRS: IAutoClosingPairConditional[] = [
	...pairsFromBrackets(JSON_BRACKETS),
	autoPair('"', '"', ['string']),
];
const RUST_PAIRS: IAutoClosingPairConditional[] = [
	...pairsFromBrackets(BRACKETS),
	autoPair('"', '"', ['string']),
];
const ECMASCRIPT_INDENTATION_RULES: IndentationRule = {
	decreaseIndentPattern: /^\s*[\}\]\)].*$/,
	increaseIndentPattern: /^.*(\{[^}]*|\([^)]*|\[[^\]]*)$/,
	indentNextLinePattern: /^((.*=>\s*)|((.*[^\w]+|\s*)((if|while|for)\s*\(.*\)\s*|else\s*)))$/,
	unIndentedLinePattern: /^(\t|[ ])*[ ]\*[^/]*\*\/\s*$|^(\t|[ ])*[ ]\*\/\s*$|^(\t|[ ])*\*([ ]([^\*]|\*(?!\/))*)?$/,
};
const JSON_INDENTATION_RULES: IndentationRule = {
	increaseIndentPattern: /({+(?=((\\.|[^"\\])*"(\\.|[^"\\])*")*[^"}]*)$)|(\[+(?=((\\.|[^"\\])*"(\\.|[^"\\])*")*[^"\]]*)$)/,
	decreaseIndentPattern: /^\s*[}\]],?\s*$/,
};
const RUST_INDENTATION_RULES: IndentationRule = {
	decreaseIndentPattern: /^\s*[\}\]\)].*$/,
	increaseIndentPattern: /^.*(\{[^}]*|\([^)]*|\[[^\]]*)$/,
};
const LINE_COMMENT_REGION_MARKERS: FoldingMarkers = {
	start: /^\s*\/\/\s*#?region\b/iu,
	end: /^\s*\/\/\s*#?endregion\b/iu,
};
const ECMASCRIPT_ON_ENTER_RULES: OnEnterRule[] = [
	onEnter(/^\s*\/\*\*(?!\/)([^\*]|\*(?!\/))*$/, IndentAction.IndentOutdent, { afterText: /^\s*\*\/$/, appendText: ' * ' }),
	onEnter(/^\s*\/\*\*(?!\/)([^\*]|\*(?!\/))*$/, IndentAction.None, { appendText: ' * ' }),
	onEnter(/^(\t|[ ])*\*([ ]([^\*]|\*(?!\/))*)?$/, IndentAction.None, { previousLineText: /(?=^(\s*(\/\*\*|\*)).*)(?=(?!(\s*\*\/)))/, appendText: '* ' }),
	onEnter(/^(\t|[ ])*[ ]\*\/\s*$/, IndentAction.None, { removeText: 1 }),
	onEnter(/^(\t|[ ])*[ ]\*[^/]*\*\/\s*$/, IndentAction.None, { removeText: 1 }),
	onEnter(/^\s*(\bcase\s.+:|\bdefault:)$/, IndentAction.Indent, { afterText: /^(?!\s*(\bcase\b|\bdefault\b))/ }),
];
const JSONC_ON_ENTER_RULES: OnEnterRule[] = [
	onEnter(/^\s*\/\/\s*\S|\s\/\/\s+\S/, IndentAction.None, { afterText: /^(?!\s*$)/, appendText: '// ' }),
];
const RUST_ON_ENTER_RULES: OnEnterRule[] = [
	onEnter(/^\s*\/\/\/.*$/, IndentAction.None, { appendText: '/// ' }),
	onEnter(/^\s*\/\/!.*$/, IndentAction.None, { appendText: '//! ' }),
	onEnter(/^\s*\/\/.*$/, IndentAction.None, { appendText: '// ' }),
	...ECMASCRIPT_ON_ENTER_RULES,
];
const PROGRAMMING_WORD_PATTERN = /[$\p{ID_Start}_][$\p{ID_Continue}]*/u;

interface BuiltinOnEnterOptions {
	readonly afterText?: RegExp;
	readonly previousLineText?: RegExp;
	readonly appendText?: string;
	readonly removeText?: number;
}

const ECMASCRIPT_CONFIGURATION: LanguageConfiguration = {
	comments: { lineComment: '//', blockComment: ['/*', '*/'] },
	brackets: BRACKETS,
	autoClosingPairs: ECMASCRIPT_PAIRS,
	surroundingPairs: ECMASCRIPT_PAIRS,
	indentationRules: ECMASCRIPT_INDENTATION_RULES,
	folding: { markers: LINE_COMMENT_REGION_MARKERS },
	onEnterRules: ECMASCRIPT_ON_ENTER_RULES,
	wordPattern: PROGRAMMING_WORD_PATTERN,
};
const JSON_CONFIGURATION: LanguageConfiguration = {
	brackets: JSON_BRACKETS,
	autoClosingPairs: JSON_PAIRS,
	surroundingPairs: JSON_PAIRS,
	indentationRules: JSON_INDENTATION_RULES,
	wordPattern: PROGRAMMING_WORD_PATTERN,
};
const JSONC_CONFIGURATION: LanguageConfiguration = {
	comments: { lineComment: '//', blockComment: ['/*', '*/'] },
	brackets: JSON_BRACKETS,
	autoClosingPairs: JSON_PAIRS,
	surroundingPairs: JSON_PAIRS,
	indentationRules: JSON_INDENTATION_RULES,
	folding: { markers: LINE_COMMENT_REGION_MARKERS },
	onEnterRules: JSONC_ON_ENTER_RULES,
	wordPattern: PROGRAMMING_WORD_PATTERN,
};
const RUST_CONFIGURATION: LanguageConfiguration = {
	comments: { lineComment: '//', blockComment: ['/*', '*/'] },
	brackets: BRACKETS,
	autoClosingPairs: RUST_PAIRS,
	surroundingPairs: RUST_PAIRS,
	indentationRules: RUST_INDENTATION_RULES,
	folding: { markers: LINE_COMMENT_REGION_MARKERS },
	onEnterRules: RUST_ON_ENTER_RULES,
	wordPattern: PROGRAMMING_WORD_PATTERN,
};

export function registerBuiltinLanguageConfigurations(service: ILanguageConfigurationService): IDisposable {
	const registrations = new DisposableStore();
	for (const languageId of ECMASCRIPT_LANGUAGE_IDS) registrations.add(service.register(languageId, ECMASCRIPT_CONFIGURATION));
	registrations.add(service.register('json', JSON_CONFIGURATION));
	registrations.add(service.register('jsonc', JSONC_CONFIGURATION));
	registrations.add(service.register('rust', RUST_CONFIGURATION));
	return registrations;
}

function pairsFromBrackets(brackets: readonly CharacterPair[]): IAutoClosingPairConditional[] {
	return brackets.map(([open, close]) => ({ open, close }));
}

function autoPair(open: string, close: string, notIn: string[]): IAutoClosingPairConditional {
	return { open, close, notIn };
}

function onEnter(beforeText: RegExp, indentAction: IndentAction, options: BuiltinOnEnterOptions = {}): OnEnterRule {
	return {
		beforeText,
		...(options.afterText === undefined ? {} : { afterText: options.afterText }),
		...(options.previousLineText === undefined ? {} : { previousLineText: options.previousLineText }),
		action: {
			indentAction,
			...(options.appendText === undefined ? {} : { appendText: options.appendText }),
			...(options.removeText === undefined ? {} : { removeText: options.removeText }),
		},
	};
}



const BUILTIN_LANGUAGE_DESCRIPTIONS: readonly LanguageDescription[] = Object.freeze([
	{ id: "c", extensions: [".c"] },
	{ id: "cpp", extensions: [".cc", ".cpp"] },
	{ id: "csharp", extensions: [".cs"] },
	{ id: "css", extensions: [".css"], mimetypes: ["text/css"] },
	{ id: "go", extensions: [".go"] },
	{ id: "html", extensions: [".html"], mimetypes: ["text/html"] },
	{ id: "java", extensions: [".java"] },
	{ id: "javascript", extensions: [".js", ".mjs"], mimetypes: ["application/javascript", "text/javascript"] },
	{ id: "javascriptreact", extensions: [".jsx"] },
	{ id: "json", extensions: [".json"], mimetypes: ["application/json"] },
	{ id: "jsonc", extensions: [".jsonc"] },
	{ id: "markdown", extensions: [".md"], mimetypes: ["text/markdown"] },
	{ id: "python", extensions: [".py"] },
	{ id: "rust", extensions: [".rs"] },
	{ id: "shellscript", extensions: [".sh"] },
	{ id: "sql", extensions: [".sql"] },
	{ id: "typescript", extensions: [".ts"], mimetypes: ["application/typescript", "text/typescript"] },
	{ id: "typescriptreact", extensions: [".tsx"] },
	{ id: "plaintext", extensions: [".txt"], mimetypes: ["text/plain"] },
	{ id: "xml", extensions: [".xml"] },
	{ id: "yaml", extensions: [".yaml", ".yml"] },
	{ id: "ini", extensions: [".toml"] },
]);

/** Registers the product's baseline language associations before extensions load. */
export function registerBuiltinLanguageDescriptions(registry: LanguagesRegistry): IDisposable {
	const registrations = new DisposableStore();
	for (const description of BUILTIN_LANGUAGE_DESCRIPTIONS) registrations.add(registry.register(description));
	return registrations;
}
