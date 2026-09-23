import type { IJSONSchemaSnippet, JsonSchema } from '../../../base/common/jsonSchema.js';
import { EDITOR_MODEL_DEFAULTS } from '../core/misc/textModelDefaults.js';
import { EDITOR_FONT_DEFAULTS } from './fontInfo.js';
import { diffEditorDefaultOptions } from './diffEditor.js';
import { editorOptionsRegistry, EditorLineWrapping } from './editorOptions.js';
import { Extensions as ConfigurationExtensions, type IConfigurationPropertySchema, type IConfigurationRegistry } from '../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../platform/registry/common/platform.js';

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

/** The common configuration node shape used by VS Code settings tooling. */
export interface EditorConfigurationNode {
	readonly id: string;
	readonly order: number;
	readonly type: 'object';
	readonly title: string;
	readonly scope: 'language-overridable';
	readonly properties: Record<string, JsonSchema>;
	readonly additionalProperties?: boolean | JsonSchema;
}

export const editorConfigurationBaseNode = Object.freeze({
	id: 'editor',
	order: 5,
	type: 'object' as const,
	title: 'Editor',
	scope: 'language-overridable' as const,
});

const properties: Record<string, JsonSchema> = {
	'editor.tabSize': {
		type: 'number',
		default: EDITOR_MODEL_DEFAULTS.tabSize,
		minimum: 1,
		maximum: 100,
		description: 'The number of spaces a tab is equal to.',
	},
	'editor.indentSize': {
		anyOf: [
			{ type: 'string', enum: ['tabSize'] },
			{ type: 'number', minimum: 1 },
		],
		default: 'tabSize',
		description: 'The number of spaces used for indentation, or "tabSize" to use editor.tabSize.',
	},
	'editor.insertSpaces': {
		type: 'boolean',
		default: EDITOR_MODEL_DEFAULTS.insertSpaces,
		description: 'Insert spaces when pressing Tab.',
	},
	'editor.detectIndentation': {
		type: 'boolean',
		default: EDITOR_MODEL_DEFAULTS.detectIndentation,
		description: 'Detect editor.tabSize and editor.insertSpaces from file contents.',
	},
	'editor.trimAutoWhitespace': {
		type: 'boolean',
		default: EDITOR_MODEL_DEFAULTS.trimAutoWhitespace,
		description: 'Remove trailing auto-inserted whitespace.',
	},
	'editor.largeFileOptimizations': {
		type: 'boolean',
		default: EDITOR_MODEL_DEFAULTS.largeFileOptimizations,
		description: 'Disable memory-intensive features for large files.',
	},
	'editor.wordBasedSuggestions': {
		type: 'string',
		enum: ['off', 'offWithInlineSuggestions', 'currentDocument', 'matchingDocuments', 'allDocuments'],
		default: 'offWithInlineSuggestions',
		description: 'Controls whether completions use words from the document.',
	},
	'editor.semanticHighlighting.enabled': {
		enum: [true, false, 'configuredByTheme'],
		default: 'configuredByTheme',
		description: 'Controls whether semantic highlighting is shown.',
	},
	'editor.stablePeek': {
		type: 'boolean',
		default: false,
		description: 'Keep peek editors open when their content is activated or Escape is pressed.',
	},
	'editor.maxTokenizationLineLength': {
		type: 'integer',
		default: 20_000,
		minimum: 1,
		description: 'Lines above this length are not tokenized for performance reasons.',
	},
	'editor.experimental.asyncTokenization': {
		type: 'boolean',
		default: true,
		tags: ['experimental'],
	},
	'editor.experimental.asyncTokenizationLogging': {
		type: 'boolean',
		default: false,
		description: 'Log asynchronous tokenization decisions for diagnostics.',
	},
	'editor.experimental.asyncTokenizationVerification': {
		type: 'boolean',
		default: false,
		tags: ['experimental'],
		description: 'Verify asynchronous tokenization against the synchronous tokenizer.',
	},
	'editor.experimental.treeSitterTelemetry': {
		type: 'boolean',
		default: false,
		tags: ['experimental'],
	},
	'editor.experimental.preferTreeSitter.css': {
		type: 'boolean',
		default: false,
		tags: ['experimental'],
	},
	'editor.experimental.preferTreeSitter.typescript': {
		type: 'boolean',
		default: false,
		tags: ['experimental'],
	},
	'editor.experimental.preferTreeSitter.ini': {
		type: 'boolean',
		default: false,
		tags: ['experimental'],
	},
	'editor.experimental.preferTreeSitter.regex': {
		type: 'boolean',
		default: false,
		tags: ['experimental'],
	},
	'editor.language.brackets': {
		type: ['array', 'null'],
		default: null,
		items: {
			type: 'array',
			items: [
				{ type: 'string' },
				{ type: 'string' },
			],
		},
	},
	'editor.language.colorizedBracketPairs': {
		type: ['array', 'null'],
		default: null,
		items: {
			type: 'array',
			items: [
				{ type: 'string' },
				{ type: 'string' },
			],
		},
	},
	'editor.fontFamily': { type: 'string', default: EDITOR_FONT_DEFAULTS.fontFamily },
	'editor.fontSize': { type: 'number', default: EDITOR_FONT_DEFAULTS.fontSize, minimum: 6, maximum: 100 },
	'editor.lineHeight': { type: 'number', default: EDITOR_FONT_DEFAULTS.lineHeight, minimum: 0, maximum: 150 },
	'editor.fontLigatures': { type: ['boolean', 'string'], default: false },
	'editor.fontVariations': { type: ['boolean', 'string'], default: false },
	'editor.wordWrap': {
		type: 'string',
		enum: ['off', 'on', 'wordWrapColumn', 'bounded'],
		default: EditorLineWrapping.Off,
	},
	'editor.wordWrapColumn': { type: 'number', default: 80, minimum: 1 },
	'editor.wrappingStrategy': { type: 'string', enum: ['simple', 'advanced'], default: 'simple' },
	'editor.wrappingIndent': { type: 'string', enum: ['none', 'same', 'indent', 'deepIndent'], default: 'same' },
	'editor.renderWhitespace': { type: 'string', enum: ['none', 'boundary', 'selection', 'trailing', 'all'], default: 'selection' },
	'editor.renderControlCharacters': { type: 'boolean', default: true },
	'editor.renderLineHighlight': { type: 'string', enum: ['none', 'gutter', 'line', 'all'], default: 'line' },
	'editor.renderLineHighlightOnlyWhenFocus': { type: 'boolean', default: false },
	'editor.scrollBeyondLastLine': { type: 'boolean', default: true },
	'editor.scrollBeyondLastColumn': { type: 'number', default: 4, minimum: 0 },
	'editor.smoothScrolling': { type: 'boolean', default: false },
	'editor.automaticLayout': { type: 'boolean', default: false },
	'editor.mouseWheelZoom': { type: 'boolean', default: false },
	'editor.mouseStyle': { type: 'string', enum: ['text', 'default', 'copy'], default: 'text' },
	'editor.cursorBlinking': { type: 'string', enum: ['blink', 'smooth', 'phase', 'expand', 'solid'], default: 'blink' },
	'editor.cursorSmoothCaretAnimation': { type: 'string', enum: ['off', 'explicit', 'on'], default: 'off' },
	'editor.cursorStyle': { type: 'string', enum: ['line', 'block', 'underline', 'line-thin', 'block-outline', 'underline-thin'], default: 'line' },
	'editor.cursorWidth': { type: 'number', default: 0, minimum: 0 },
	'editor.cursorSurroundingLines': { type: 'number', default: 0, minimum: 0 },
	'editor.cursorSurroundingLinesStyle': { type: 'string', enum: ['default', 'all'], default: 'default' },
	'editor.lineNumbersMinChars': { type: 'number', default: 5, minimum: 1 },
	'editor.glyphMargin': { type: 'boolean', default: true },
	'editor.lineDecorationsWidth': { type: ['number', 'string'], default: 10 },
	'editor.overviewRulerLanes': { type: 'number', default: 3, minimum: 0, maximum: 3 },
	'editor.overviewRulerBorder': { type: 'boolean', default: true },
	'editor.revealHorizontalRightPadding': { type: 'number', default: 15, minimum: 0 },
	'editor.roundedSelection': { type: 'boolean', default: true },
	'editor.selectionClipboard': { type: 'boolean', default: true },
	'editor.emptySelectionClipboard': { type: 'boolean', default: true },
	'editor.copyWithSyntaxHighlighting': { type: 'boolean', default: true },
	'editor.links': { type: 'boolean', default: true },
	'editor.colorDecorators': { type: 'boolean', default: true },
	'editor.colorDecoratorsActivatedOn': { type: 'string', enum: ['clickAndHover', 'click', 'hover'], default: 'clickAndHover' },
	'editor.colorDecoratorsLimit': { type: 'number', default: 500, minimum: 0 },
	'editor.columnSelection': { type: 'boolean', default: false },
	'editor.multiCursorModifier': { type: 'string', enum: ['ctrlCmd', 'alt'], default: 'alt' },
	'editor.multiCursorMergeOverlapping': { type: 'boolean', default: true },
	'editor.multiCursorLimit': { type: 'number', default: 10_000, minimum: 1 },
	'editor.accessibilitySupport': { type: 'string', enum: ['auto', 'off', 'on'], default: 'auto' },
	'editor.accessibilityPageSize': { type: 'number', default: 500, minimum: 1 },
	'editor.tabFocusMode': { type: 'boolean', default: false },
	'editor.find.cursorMoveOnType': { type: 'boolean', default: true },
	'editor.find.findOnType': { type: 'boolean', default: true },
	'editor.find.seedSearchStringFromSelection': { type: 'string', enum: ['never', 'always', 'selection'], default: 'always' },
	'editor.find.autoFindInSelection': { type: 'string', enum: ['never', 'always', 'multiline'], default: 'never' },
	'editor.find.loop': { type: 'boolean', default: true },
	'editor.find.closeOnResult': { type: 'boolean', default: false },
	'editor.find.history': { type: 'string', enum: ['never', 'workspace'], default: 'workspace' },
	'editor.find.replaceHistory': { type: 'string', enum: ['never', 'workspace'], default: 'workspace' },
	'editor.autoClosingBrackets': { type: 'string', enum: ['always', 'languageDefined', 'beforeWhitespace', 'never'], default: 'languageDefined' },
	'editor.autoClosingQuotes': { type: 'string', enum: ['always', 'languageDefined', 'beforeWhitespace', 'never'], default: 'languageDefined' },
	'editor.autoClosingDelete': { type: 'string', enum: ['always', 'auto', 'never'], default: 'auto' },
	'editor.autoClosingOvertype': { type: 'string', enum: ['always', 'auto', 'never'], default: 'auto' },
	'editor.autoSurround': { type: 'string', enum: ['languageDefined', 'quotes', 'brackets', 'never'], default: 'languageDefined' },
	'editor.autoIndent': { type: 'string', enum: ['none', 'keep', 'brackets', 'advanced', 'full'], default: 'full' },
	'editor.autoIndentOnPaste': { type: 'boolean', default: false },
	'editor.formatOnType': { type: 'boolean', default: false },
	'editor.formatOnPaste': { type: 'boolean', default: false },
	'editor.codeLens': { type: 'boolean', default: true },
	'editor.codeLensFontFamily': { type: 'string', default: '' },
	'editor.codeLensFontSize': { type: 'number', default: 0, minimum: 0 },
	'editor.folding': { type: 'boolean', default: true },
	'editor.foldingStrategy': { type: 'string', enum: ['auto', 'indentation'], default: 'auto' },
	'editor.foldingHighlight': { type: 'boolean', default: true },
	'editor.foldingMaximumRegions': { type: 'number', default: 5000, minimum: 1 },
	'editor.showFoldingControls': { type: 'string', enum: ['always', 'never', 'mouseover'], default: 'mouseover' },
	'editor.matchBrackets': { type: 'string', enum: ['never', 'near', 'always'], default: 'always' },
	'editor.suggestOnTriggerCharacters': { type: 'boolean', default: true },
	'editor.acceptSuggestionOnEnter': { type: 'string', enum: ['on', 'smart', 'off'], default: 'on' },
	'editor.acceptSuggestionOnCommitCharacter': { type: 'boolean', default: true },
	'editor.snippetSuggestions': { type: 'string', enum: ['top', 'bottom', 'inline', 'none'], default: 'inline' },
	'editor.suggestSelection': { type: 'string', enum: ['first', 'recentlyUsed', 'recentlyUsedByPrefix'], default: 'first' },
	'editor.suggestFontSize': { type: 'number', default: 0, minimum: 0 },
	'editor.suggestLineHeight': { type: 'number', default: 0, minimum: 0 },
	'editor.tabCompletion': { type: 'string', enum: ['on', 'off', 'onlySnippets'], default: 'off' },
	'editor.selectionHighlight': { type: 'boolean', default: true },
	'editor.selectionHighlightMultiline': { type: 'boolean', default: false },
	'editor.selectionHighlightMaxLength': { type: 'number', default: 200, minimum: 0 },
	'editor.occurrencesHighlight': { type: 'string', enum: ['off', 'singleFile', 'multiFile'], default: 'singleFile' },
	'editor.occurrencesHighlightDelay': { type: 'number', default: 250, minimum: 0, maximum: 2000 },
	'editor.unusualLineTerminators': { type: 'string', enum: ['auto', 'off', 'prompt'], default: 'prompt' },
	'editor.useTabStops': { type: 'boolean', default: true },
	'editor.trimWhitespaceOnDelete': { type: 'boolean', default: false },
	'editor.wordBreak': { type: 'string', enum: ['normal', 'keepAll'], default: 'normal' },
	'editor.wordSeparators': { type: 'string', default: `~!@#$%^&*()-=+[\\]{}\\\\|;:'\",.<>/?` },
	'editor.defaultColorDecorators': { type: 'string', enum: ['auto', 'always', 'never'], default: 'auto' },
	'editor.renderValidationDecorations': { type: 'string', enum: ['editable', 'on', 'off'], default: 'editable' },
	'editor.minimap.enabled': { type: 'boolean', default: true },
	'editor.minimap.side': { type: 'string', enum: ['right', 'left'], default: 'right' },
	'editor.minimap.renderCharacters': { type: 'boolean', default: true },
	'editor.minimap.showSlider': { type: 'string', enum: ['always', 'mouseover'], default: 'mouseover' },
	'editor.minimap.maxColumn': { type: 'number', default: 120, minimum: 1 },
	'editor.scrollbar.vertical': { type: 'string', enum: ['auto', 'visible', 'hidden'], default: 'auto' },
	'editor.scrollbar.horizontal': { type: 'string', enum: ['auto', 'visible', 'hidden'], default: 'auto' },
	'editor.scrollbar.verticalScrollbarSize': { type: 'number', default: 14, minimum: 0 },
	'editor.scrollbar.horizontalScrollbarSize': { type: 'number', default: 14, minimum: 0 },
	'editor.stickyScroll.enabled': { type: 'boolean', default: true },
	'editor.stickyScroll.maxLineCount': { type: 'number', default: 5, minimum: 1 },
	'editor.bracketPairColorization.enabled': { type: 'boolean', default: EDITOR_MODEL_DEFAULTS.bracketPairColorizationOptions.enabled },
	'editor.bracketPairColorization.independentColorPoolPerBracketType': { type: 'boolean', default: EDITOR_MODEL_DEFAULTS.bracketPairColorizationOptions.independentColorPoolPerBracketType },
	'editor.unicodeHighlight.invisibleCharacters': { type: 'boolean', default: true },
	'editor.unicodeHighlight.ambiguousCharacters': { type: 'boolean', default: true },
	'editor.unicodeHighlight.includeComments': { type: 'boolean', default: false },
	'editor.inlineSuggest.enabled': { type: 'boolean', default: true },
	'editor.parameterHints.enabled': { type: 'boolean', default: true },
	'editor.inlayHints.enabled': { type: 'boolean', default: true },
	'diffEditor.maxComputationTime': { type: 'number', default: diffEditorDefaultOptions.maxComputationTime, minimum: 0 },
	'diffEditor.maxFileSize': { type: 'number', default: diffEditorDefaultOptions.maxFileSize, minimum: 0 },
	'diffEditor.renderSideBySide': { type: 'boolean', default: diffEditorDefaultOptions.renderSideBySide },
	'diffEditor.renderSideBySideInlineBreakpoint': { type: 'number', default: diffEditorDefaultOptions.renderSideBySideInlineBreakpoint, minimum: 0 },
	'diffEditor.useInlineViewWhenSpaceIsLimited': { type: 'boolean', default: diffEditorDefaultOptions.useInlineViewWhenSpaceIsLimited },
	'diffEditor.renderMarginRevertIcon': { type: 'boolean', default: diffEditorDefaultOptions.renderMarginRevertIcon },
	'diffEditor.renderGutterMenu': { type: 'boolean', default: diffEditorDefaultOptions.renderGutterMenu },
	'diffEditor.ignoreTrimWhitespace': { type: 'boolean', default: diffEditorDefaultOptions.ignoreTrimWhitespace },
	'diffEditor.renderIndicators': { type: 'boolean', default: diffEditorDefaultOptions.renderIndicators },
	'diffEditor.codeLens': { type: 'boolean', default: diffEditorDefaultOptions.diffCodeLens },
	'diffEditor.wordWrap': { type: 'string', enum: ['off', 'on', 'inherit'], default: diffEditorDefaultOptions.diffWordWrap },
	'diffEditor.diffAlgorithm': { type: 'string', enum: ['legacy', 'advanced', 'advanced-external', 'advanced-wasm'], default: diffEditorDefaultOptions.diffAlgorithm },
	'diffEditor.hideUnchangedRegions.enabled': { type: 'boolean', default: diffEditorDefaultOptions.hideUnchangedRegions.enabled },
	'diffEditor.hideUnchangedRegions.revealLineCount': { type: 'integer', default: diffEditorDefaultOptions.hideUnchangedRegions.revealLineCount, minimum: 1 },
	'diffEditor.hideUnchangedRegions.minimumLineCount': { type: 'integer', default: diffEditorDefaultOptions.hideUnchangedRegions.minimumLineCount, minimum: 1 },
	'diffEditor.hideUnchangedRegions.contextLineCount': { type: 'integer', default: diffEditorDefaultOptions.hideUnchangedRegions.contextLineCount, minimum: 1 },
	'diffEditor.experimental.showMoves': { type: 'boolean', default: diffEditorDefaultOptions.experimental.showMoves },
	'diffEditor.experimental.showEmptyDecorations': { type: 'boolean', default: diffEditorDefaultOptions.experimental.showEmptyDecorations },
	'diffEditor.experimental.useTrueInlineView': { type: 'boolean', default: diffEditorDefaultOptions.experimental.useTrueInlineView },
};

/** JSON schema for the editor settings namespace. */
export const editorConfiguration: EditorConfigurationNode = {
	...editorConfigurationBaseNode,
	properties,
};

// Add schemas contributed by option descriptors, as in VS Code's registry.
for (const editorOption of editorOptionsRegistry) {
	const schema = editorOption?.schema;
	if (!schema) continue;
	if (isConfigurationPropertySchema(schema)) {
		properties[`editor.${editorOption.name}`] = schema;
	} else {
		for (const [key, value] of Object.entries(schema)) properties[key] = value;
	}
}

// VS Code's registry contributes a schema for nearly every public option. A
// Ash adapter may not need the full browser computation yet, but settings
// consumers should still see the same option names and basic value shape.
const internalOptionNames = new Set([
	'fontInfo',
	'effectiveCursorStyle',
	'editorClassName',
	'pixelRatio',
	'layoutInfo',
	'wrappingInfo',
	'wrappingIndent',
	'wrappingStrategy',
	'effectiveEditContext',
	'effectiveAllowVariableFonts',
]);
for (const editorOption of editorOptionsRegistry) {
	if (!editorOption || internalOptionNames.has(editorOption.name)) continue;
	const key = `editor.${editorOption.name}`;
	if (!properties[key]) properties[key] = schemaForDefault(editorOption.defaultValue);
}

let cachedEditorConfigurationKeys: ReadonlySet<string> | undefined;

function getEditorConfigurationKeys(): ReadonlySet<string> {
	if (!cachedEditorConfigurationKeys) cachedEditorConfigurationKeys = new Set(Object.keys(properties));
	return cachedEditorConfigurationKeys;
}

/** Returns whether a relative key belongs to the editor configuration namespace. */
export function isEditorConfigurationKey(key: string): boolean {
	return getEditorConfigurationKeys().has(`editor.${key}`);
}

/** Returns whether a relative key belongs to the diff-editor configuration namespace. */
export function isDiffEditorConfigurationKey(key: string): boolean {
	return getEditorConfigurationKeys().has(`diffEditor.${key}`);
}

/** Adds host-provided font snippets to the editor font-family setting. */
export async function registerEditorFontConfigurations(getFontSnippets: () => Promise<IJSONSchemaSnippet[]>) {
	const snippets = await getFontSnippets();
	const fontFamilySchema = properties['editor.fontFamily'];
	if (!fontFamilySchema) return;
	properties['editor.fontFamily'] = { ...fontFamilySchema, defaultSnippets: Object.freeze([...snippets]) };
	cachedEditorConfigurationKeys = undefined;
}

function isConfigurationPropertySchema(schema: IConfigurationPropertySchema | { [path: string]: IConfigurationPropertySchema }): schema is IConfigurationPropertySchema {
	return typeof schema === 'object' && (
		schema.type !== undefined ||
		schema.anyOf !== undefined ||
		schema.allOf !== undefined ||
		schema.oneOf !== undefined ||
		schema.enum !== undefined
	);
}

function schemaForDefault(value: unknown): JsonSchema {
	if (typeof value === 'boolean') return { type: 'boolean', default: value };
	if (typeof value === 'number') return { type: 'number', default: value };
	if (typeof value === 'string') return { type: 'string', default: value };
	if (Array.isArray(value)) return { type: 'array', default: Object.freeze([...value]) };
	if (value && typeof value === 'object') return { type: 'object' };
	return {};
}

// The schema owner also registers the model settings consumed by editor services.
configurationRegistry.registerConfiguration({
	key: 'editor.maxTokenizationLineLength',
	defaultValue: 20_000,
	parse(value) {
		if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
			throw new RangeError('editor.maxTokenizationLineLength must be a positive integer');
		}
		return value;
	},
});
configurationRegistry.registerConfiguration({
	key: 'editor.tabSize',
	defaultValue: EDITOR_MODEL_DEFAULTS.tabSize,
	parse: value => modelInteger(value, 'editor.tabSize'),
	setting: { title: 'Tab size', description: 'Set the number of columns represented by one tab.', valueType: 'number', minimum: 1, maximum: 100 },
});
configurationRegistry.registerConfiguration<number | 'tabSize'>({
	key: 'editor.indentSize',
	defaultValue: 'tabSize',
	parse: value => value === 'tabSize' ? value : modelInteger(value, 'editor.indentSize'),
});
for (const [key, defaultValue] of [
	['editor.insertSpaces', EDITOR_MODEL_DEFAULTS.insertSpaces],
	['editor.detectIndentation', EDITOR_MODEL_DEFAULTS.detectIndentation],
	['editor.trimAutoWhitespace', EDITOR_MODEL_DEFAULTS.trimAutoWhitespace],
	['editor.largeFileOptimizations', EDITOR_MODEL_DEFAULTS.largeFileOptimizations],
	['editor.bracketPairColorization.enabled', EDITOR_MODEL_DEFAULTS.bracketPairColorizationOptions.enabled],
	['editor.bracketPairColorization.independentColorPoolPerBracketType', EDITOR_MODEL_DEFAULTS.bracketPairColorizationOptions.independentColorPoolPerBracketType],
] as const) {
	configurationRegistry.registerConfiguration({
		key,
		defaultValue,
		parse: value => modelBoolean(value, key),
	});
}
configurationRegistry.registerConfiguration<'auto' | '\n' | '\r\n'>({
	key: 'files.eol',
	defaultValue: 'auto',
	parse(value) {
		if (value === 'auto' || value === '\n' || value === '\r\n') return value;
		throw new TypeError('files.eol must be auto, LF, or CRLF');
	},
});
configurationRegistry.registerConfiguration({
	key: 'files.restoreUndoStack',
	defaultValue: true,
	parse: value => modelBoolean(value, 'files.restoreUndoStack'),
});

function modelBoolean(value: unknown, key: string): boolean {
	if (typeof value !== 'boolean') throw new TypeError(`${key} must be boolean`);
	return value;
}

function modelInteger(value: unknown, key: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 100) {
		throw new RangeError(`${key} must be an integer between 1 and 100`);
	}
	return value as number;
}
