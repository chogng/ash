import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from "../../../../platform/configuration/common/configurationRegistry.js";
import { Registry } from "../../../../platform/registry/common/platform.js";
import { EditorIndentationKind } from "../../../../editor/common/core/misc/indentation.js";
import { EditorLineWrapping } from "../../../../editor/common/config/editorOptions.js";
import '../../../../editor/common/config/editorConfigurationSchema.js';
import type { IDocumentDiffProviderOptions } from '../../../../editor/common/diff/documentDiffProvider.js';
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

export type WrappingIndentSetting = "none" | "same" | "indent" | "deepIndent";
export type MatchBracketsSetting = "never" | "near" | "always";
export type ColorDecoratorsActivatedOnSetting = "clickAndHover" | "click" | "hover";
export type DefaultColorDecoratorsSetting = "auto" | "always" | "never";
export type CursorStyleSetting = 'line' | 'block' | 'underline' | 'line-thin' | 'block-outline' | 'underline-thin';
export type CursorBlinkingSetting = 'blink' | 'smooth' | 'phase' | 'expand' | 'solid';
export type CursorSmoothCaretAnimationSetting = 'off' | 'explicit' | 'on';
export type RenderLineHighlightSetting = 'none' | 'gutter' | 'line' | 'all';

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

/** Typed user preferences owned by the Workbench code-editor integration. */
export const CodeEditorConfiguration = Object.freeze({
	fontFamily: configurationRegistry.registerConfiguration<string>({
		key: "editor.fontFamily",
		defaultValue: "",
		parse(value: unknown): string {
			if (typeof value === "string" && value.length <= 256 && !/[\r\n\0]/u.test(value)) return value;
			throw new TypeError("editor.fontFamily must be a single-line string no longer than 256 characters");
		},
		setting: textSetting("Font family", "Use a CSS font-family list, or leave this empty to use the default monospace font.", "Default monospace"),
	}),
	fontSize: configurationRegistry.registerConfiguration<number>({
		key: "editor.fontSize",
		defaultValue: 13,
		parse(value: unknown): number {
			if (Number.isSafeInteger(value) && (value as number) >= 8 && (value as number) <= 40) return value as number;
			throw new RangeError(`editor.fontSize must be an integer between 8 and 40; received ${String(value)}`);
		},
		setting: numberSetting("Font size", "Set the editor text size in pixels.", 8, 40),
	}),
	lineHeight: configurationRegistry.registerConfiguration<number>({
		key: "editor.lineHeight",
		defaultValue: 20,
		parse(value: unknown): number {
			if (Number.isSafeInteger(value) && (value as number) >= 12 && (value as number) <= 80) return value as number;
			throw new RangeError(`editor.lineHeight must be an integer between 12 and 80; received ${String(value)}`);
		},
		setting: numberSetting("Line height", "Set the height of each editor line in pixels.", 12, 80),
	}),
	fontLigatures: configurationRegistry.registerConfiguration<boolean>({
		key: "editor.fontLigatures",
		defaultValue: false,
		parse: value => parseBoolean(value, "editor.fontLigatures"),
		setting: booleanSetting("Font ligatures", "Use programming ligatures when the selected font supports them."),
	}),
	experimentalGpuAcceleration: configurationRegistry.registerConfiguration<"on" | "off">({
		key: "editor.experimentalGpuAcceleration",
		defaultValue: "off",
		parse(value: unknown): "on" | "off" {
			if (value === "on" || value === "off") return value;
			throw new TypeError(`editor.experimentalGpuAcceleration must be on or off; received ${String(value)}`);
		},
		setting: selectSetting("GPU acceleration", "Draw eligible visible editor text through the experimental WebGPU backend.", [
			{ value: "off", label: "Off" },
			{ value: "on", label: "On" },
		]),
	}),
	wordWrap: configurationRegistry.registerConfiguration<EditorLineWrapping>({
		key: "editor.wordWrap",
		defaultValue: EditorLineWrapping.Off,
		parse(value: unknown): EditorLineWrapping {
			if (value === EditorLineWrapping.Off || value === EditorLineWrapping.On) return value;
			throw new TypeError(`editor.wordWrap must be off or on; received ${String(value)}`);
		},
		setting: selectSetting("Word wrap", "Wrap long lines at the editor viewport instead of scrolling horizontally.", [
			{ value: EditorLineWrapping.Off, label: "Off" },
			{ value: EditorLineWrapping.On, label: "On" },
		]),
	}),
	wrappingIndent: configurationRegistry.registerConfiguration<WrappingIndentSetting>({
		key: "editor.wrappingIndent",
		defaultValue: "same",
		parse(value: unknown): WrappingIndentSetting {
			if (value === "none" || value === "same" || value === "indent" || value === "deepIndent") return value;
			throw new TypeError(`editor.wrappingIndent must be none, same, indent, or deepIndent; received ${String(value)}`);
		},
		setting: selectSetting("Wrapping indent", "Choose the indentation applied to continuation rows created by word wrapping.", [
			{ value: "none", label: "None" },
			{ value: "same", label: "Same" },
			{ value: "indent", label: "Indent" },
			{ value: "deepIndent", label: "Deep indent" },
		]),
	}),
	minimapEnabled: configurationRegistry.registerConfiguration<boolean>({
		key: "editor.minimap.enabled",
		defaultValue: true,
		parse: value => parseBoolean(value, "editor.minimap.enabled"),
		setting: booleanSetting("Enabled", "Show a compact document overview on the right side of the editor."),
	}),
	lineNumbers: configurationRegistry.registerConfiguration<boolean>({
		key: "editor.lineNumbers",
		defaultValue: true,
		parse: value => parseBoolean(value, "editor.lineNumbers"),
		setting: booleanSetting("Line numbers", "Show line numbers in the editor gutter."),
	}),
	indentationGuides: configurationRegistry.registerConfiguration<boolean>({
		key: "editor.guides.indentation",
		defaultValue: true,
		parse: value => parseBoolean(value, "editor.guides.indentation"),
		setting: booleanSetting("Indentation guides", "Show vertical guides aligned with indentation levels."),
	}),
	bracketPairGuides: configurationRegistry.registerConfiguration<boolean>({
		key: 'editor.guides.bracketPairs',
		defaultValue: false,
		parse: value => parseBoolean(value, 'editor.guides.bracketPairs'),
		setting: booleanSetting('Bracket pair guides', 'Show vertical guides between matching bracket pairs.'),
	}),
	bracketPairHorizontalGuides: configurationRegistry.registerConfiguration<boolean>({
		key: 'editor.guides.bracketPairsHorizontal',
		defaultValue: true,
		parse: value => parseBoolean(value, 'editor.guides.bracketPairsHorizontal'),
		setting: booleanSetting('Horizontal bracket pair guides', 'Show a horizontal guide from the active vertical guide to its closing bracket.'),
	}),
	highlightActiveBracketPairGuide: configurationRegistry.registerConfiguration<boolean>({
		key: 'editor.guides.highlightActiveBracketPair',
		defaultValue: true,
		parse: value => parseBoolean(value, 'editor.guides.highlightActiveBracketPair'),
		setting: booleanSetting('Active bracket pair guide', 'Emphasize the bracket pair guide containing the primary cursor.'),
	}),
	highlightActiveIndentationGuide: configurationRegistry.registerConfiguration<boolean>({
		key: 'editor.guides.highlightActiveIndentation',
		defaultValue: true,
		parse: value => parseBoolean(value, 'editor.guides.highlightActiveIndentation'),
		setting: booleanSetting('Active indentation guide', 'Emphasize the indentation guide containing the primary cursor.'),
	}),
	bracketPairColorization: 'editor.bracketPairColorization.enabled',
	cursorStyle: configurationRegistry.registerConfiguration<CursorStyleSetting>({
		key: 'editor.cursorStyle',
		defaultValue: 'line',
		parse: value => parseEnum(value, 'editor.cursorStyle', ['line', 'block', 'underline', 'line-thin', 'block-outline', 'underline-thin']),
		setting: selectSetting('Cursor style', 'Choose the shape of editor cursors.', [
			{ value: 'line', label: 'Line' },
			{ value: 'block', label: 'Block' },
			{ value: 'underline', label: 'Underline' },
			{ value: 'line-thin', label: 'Thin line' },
			{ value: 'block-outline', label: 'Block outline' },
			{ value: 'underline-thin', label: 'Thin underline' },
		]),
	}),
	cursorBlinking: configurationRegistry.registerConfiguration<CursorBlinkingSetting>({
		key: 'editor.cursorBlinking',
		defaultValue: 'blink',
		parse: value => parseEnum(value, 'editor.cursorBlinking', ['blink', 'smooth', 'phase', 'expand', 'solid']),
		setting: selectSetting('Cursor blinking', 'Choose how editor cursors animate.', [
			{ value: 'blink', label: 'Blink' },
			{ value: 'smooth', label: 'Smooth' },
			{ value: 'phase', label: 'Phase' },
			{ value: 'expand', label: 'Expand' },
			{ value: 'solid', label: 'Solid' },
		]),
	}),
	cursorSmoothCaretAnimation: configurationRegistry.registerConfiguration<CursorSmoothCaretAnimationSetting>({
		key: 'editor.cursorSmoothCaretAnimation',
		defaultValue: 'off',
		parse: value => parseEnum(value, 'editor.cursorSmoothCaretAnimation', ['off', 'explicit', 'on']),
		setting: selectSetting('Smooth caret animation', 'Animate cursor movement.', [
			{ value: 'off', label: 'Off' },
			{ value: 'explicit', label: 'Explicit cursor movement' },
			{ value: 'on', label: 'On' },
		]),
	}),
	cursorWidth: configurationRegistry.registerConfiguration<number>({
		key: 'editor.cursorWidth',
		defaultValue: 0,
		parse: value => parseNonNegativeInteger(value, 'editor.cursorWidth'),
		setting: numberSetting('Cursor width', 'Set the line cursor width in pixels; zero uses the editor default.', 0, 100),
	}),
	cursorHeight: configurationRegistry.registerConfiguration<number>({
		key: 'editor.cursorHeight',
		defaultValue: 0,
		parse: value => parseNonNegativeInteger(value, 'editor.cursorHeight'),
		setting: numberSetting('Cursor height', 'Set the cursor height in pixels; zero uses the full line height.', 0, 100),
	}),
	matchBrackets: configurationRegistry.registerConfiguration<MatchBracketsSetting>({
		key: "editor.matchBrackets",
		defaultValue: "always",
		parse(value: unknown): MatchBracketsSetting {
			if (value === "never" || value === "near" || value === "always") return value;
			throw new TypeError(`editor.matchBrackets must be never, near, or always; received ${String(value)}`);
		},
		setting: selectSetting("Match brackets", "Choose when matching bracket pairs are highlighted.", [
			{ value: "never", label: "Never" },
			{ value: "near", label: "Near cursor" },
			{ value: "always", label: "Always" },
		]),
	}),
	stickyScroll: configurationRegistry.registerConfiguration<boolean>({
		key: "editor.stickyScroll.enabled",
		defaultValue: true,
		parse: value => parseBoolean(value, "editor.stickyScroll.enabled"),
		setting: booleanSetting("Sticky scroll", "Keep enclosing scopes visible at the top while scrolling."),
	}),
	renderLineHighlight: configurationRegistry.registerConfiguration<RenderLineHighlightSetting>({
		key: 'editor.renderLineHighlight',
		defaultValue: 'line',
		parse: value => parseEnum(value, 'editor.renderLineHighlight', ['none', 'gutter', 'line', 'all']),
		setting: selectSetting('Render line highlight', 'Choose where lines containing cursors are highlighted.', [
			{ value: 'none', label: 'None' },
			{ value: 'gutter', label: 'Gutter' },
			{ value: 'line', label: 'Line' },
			{ value: 'all', label: 'All' },
		]),
	}),
	renderLineHighlightOnlyWhenFocus: configurationRegistry.registerConfiguration<boolean>({
		key: 'editor.renderLineHighlightOnlyWhenFocus',
		defaultValue: false,
		parse: value => parseBoolean(value, 'editor.renderLineHighlightOnlyWhenFocus'),
		setting: booleanSetting('Highlight current line only when focused', 'Hide current-line highlighting while the editor is not focused.'),
	}),
	unicodeHighlights: configurationRegistry.registerConfiguration<boolean>({
		key: "editor.unicodeHighlights",
		defaultValue: true,
		parse: value => parseBoolean(value, "editor.unicodeHighlights"),
		setting: booleanSetting("Unicode highlights", "Call attention to invisible or easily confused Unicode characters."),
	}),
	indentationKind: configurationRegistry.registerConfiguration<EditorIndentationKind>({
		key: "editor.indentation",
		defaultValue: EditorIndentationKind.Spaces,
		parse(value: unknown): EditorIndentationKind {
			if (value === EditorIndentationKind.Spaces || value === EditorIndentationKind.Tabs) return value;
			throw new TypeError(`editor.indentation must be spaces or tabs; received ${String(value)}`);
		},
		setting: selectSetting("Indent using", "Choose whether indentation inserts spaces or tab characters.", [
			{ value: EditorIndentationKind.Spaces, label: "Spaces" },
			{ value: EditorIndentationKind.Tabs, label: "Tabs" },
		]),
	}),
	tabSize: 'editor.tabSize',
	formatOnSave: configurationRegistry.registerConfiguration<boolean>({
		key: "editor.formatOnSave",
		defaultValue: false,
		parse: value => parseBoolean(value, "editor.formatOnSave"),
		setting: booleanSetting("Format on save", "Run the active language formatter before saving a file."),
	}),
	trimTrailingWhitespace: configurationRegistry.registerConfiguration<boolean>({
		key: "files.trimTrailingWhitespace",
		defaultValue: false,
		parse: value => parseBoolean(value, "files.trimTrailingWhitespace"),
		setting: booleanSetting("Trim trailing whitespace", "Remove trailing whitespace when saving a file."),
	}),
	trimTrailingWhitespaceInRegexAndStrings: configurationRegistry.registerConfiguration<boolean>({
		key: "files.trimTrailingWhitespaceInRegexAndStrings",
		defaultValue: true,
		parse: value => parseBoolean(value, "files.trimTrailingWhitespaceInRegexAndStrings"),
		setting: booleanSetting("Trim trailing whitespace in regexes and strings", "Remove trailing whitespace from multiline strings and regular expressions when saving a file."),
	}),
	findSeedFromSelection: configurationRegistry.registerConfiguration<boolean>({
		key: "editor.find.seedSearchStringFromSelection",
		defaultValue: true,
		parse: value => parseBoolean(value, "editor.find.seedSearchStringFromSelection"),
		setting: booleanSetting("Seed from selection", "Use a single-line selection as the initial Find query."),
	}),
	findAutoFindInSelection: configurationRegistry.registerConfiguration<boolean>({
		key: "editor.find.autoFindInSelection",
		defaultValue: false,
		parse: value => parseBoolean(value, "editor.find.autoFindInSelection"),
		setting: booleanSetting("Find in selection automatically", "Limit Find to the current non-empty selection when the widget opens."),
	}),
	findLoop: configurationRegistry.registerConfiguration<boolean>({
		key: "editor.find.loop",
		defaultValue: true,
		parse: value => parseBoolean(value, "editor.find.loop"),
		setting: booleanSetting("Loop through matches", "Wrap from the final match to the first match and back again."),
	}),
	findMatchCase: configurationRegistry.registerConfiguration<boolean>({
		key: "editor.find.matchCase",
		defaultValue: false,
		parse: value => parseBoolean(value, "editor.find.matchCase"),
		setting: booleanSetting("Match case by default", "Open Find with case-sensitive matching enabled."),
	}),
	findWholeWord: configurationRegistry.registerConfiguration<boolean>({
		key: "editor.find.wholeWord",
		defaultValue: false,
		parse: value => parseBoolean(value, "editor.find.wholeWord"),
		setting: booleanSetting("Whole word by default", "Open Find with whole-word matching enabled."),
	}),
	findRegularExpression: configurationRegistry.registerConfiguration<boolean>({
		key: "editor.find.useRegularExpression",
		defaultValue: false,
		parse: value => parseBoolean(value, "editor.find.useRegularExpression"),
		setting: booleanSetting("Regular expression by default", "Open Find with regular-expression matching enabled."),
	}),
	suggestions: configurationRegistry.registerConfiguration<boolean>({
		key: "editor.suggest.enabled",
		defaultValue: true,
		parse: value => parseBoolean(value, "editor.suggest.enabled"),
		setting: booleanSetting("Suggestions", "Show completion suggestions from language providers."),
	}),
	inlineCompletions: configurationRegistry.registerConfiguration<boolean>({
		key: "editor.inlineSuggest.enabled",
		defaultValue: true,
		parse: value => parseBoolean(value, "editor.inlineSuggest.enabled"),
		setting: booleanSetting("Inline completions", "Show provider-supplied completion text directly in the editor."),
	}),
	parameterHints: configurationRegistry.registerConfiguration<boolean>({
		key: "editor.parameterHints.enabled",
		defaultValue: true,
		parse: value => parseBoolean(value, "editor.parameterHints.enabled"),
		setting: booleanSetting("Parameter hints", "Show signature information while entering function arguments."),
	}),
	inlayHints: configurationRegistry.registerConfiguration<boolean>({
		key: "editor.inlayHints.enabled",
		defaultValue: true,
		parse: value => parseBoolean(value, "editor.inlayHints.enabled"),
		setting: booleanSetting("Inlay hints", "Show inferred types, parameter names, and other inline annotations."),
	}),
	codeLens: configurationRegistry.registerConfiguration<boolean>({
		key: "editor.codeLens",
		defaultValue: true,
		parse: value => parseBoolean(value, "editor.codeLens"),
		setting: booleanSetting("CodeLens", "Show provider actions and references near relevant code."),
	}),
	colorDecorators: configurationRegistry.registerConfiguration<boolean>({
		key: "editor.colorDecorators",
		defaultValue: true,
		parse: value => parseBoolean(value, "editor.colorDecorators"),
		setting: booleanSetting("Color decorators", "Show an editable color swatch beside recognized color values."),
	}),
	colorDecoratorsActivatedOn: configurationRegistry.registerConfiguration<ColorDecoratorsActivatedOnSetting>({
		key: "editor.colorDecoratorsActivatedOn",
		defaultValue: "clickAndHover",
		parse(value: unknown): ColorDecoratorsActivatedOnSetting {
			if (value === "clickAndHover" || value === "click" || value === "hover") return value;
			throw new TypeError(`editor.colorDecoratorsActivatedOn must be clickAndHover, click, or hover; received ${String(value)}`);
		},
		setting: selectSetting("Color picker activation", "Choose how color swatches open the color picker.", [
			{ value: "clickAndHover", label: "Click and hover" },
			{ value: "click", label: "Click" },
			{ value: "hover", label: "Hover" },
		]),
	}),
	colorDecoratorsLimit: configurationRegistry.registerConfiguration<number>({
		key: "editor.colorDecoratorsLimit",
		defaultValue: 500,
		parse(value: unknown): number {
			if (Number.isSafeInteger(value) && (value as number) >= 0) return value as number;
			throw new RangeError(`editor.colorDecoratorsLimit must be a non-negative integer; received ${String(value)}`);
		},
		setting: numberSetting("Color decorator limit", "Limit the number of color swatches rendered in one document.", 0, 1_000_000),
	}),
	defaultColorDecorators: configurationRegistry.registerConfiguration<DefaultColorDecoratorsSetting>({
		key: "editor.defaultColorDecorators",
		defaultValue: "auto",
		parse(value: unknown): DefaultColorDecoratorsSetting {
			if (value === "auto" || value === "always" || value === "never") return value;
			throw new TypeError(`editor.defaultColorDecorators must be auto, always, or never; received ${String(value)}`);
		},
		setting: selectSetting("Default color detection", "Choose when the editor scans CSS color literals without a language provider.", [
			{ value: "auto", label: "Auto" },
			{ value: "always", label: "Always" },
			{ value: "never", label: "Never" },
		]),
	}),
	diffIgnoreTrimWhitespace: 'diffEditor.ignoreTrimWhitespace',
	diffShowLineNumbers: configurationRegistry.registerConfiguration<boolean>({
		key: "diffEditor.showLineNumbers",
		defaultValue: true,
		parse: value => parseBoolean(value, "diffEditor.showLineNumbers"),
		setting: booleanSetting("Line numbers", "Show original and modified line numbers in diff cells."),
	}),
	diffShowInlineChanges: configurationRegistry.registerConfiguration<boolean>({
		key: "diffEditor.showInlineChanges",
		defaultValue: true,
		parse: value => parseBoolean(value, "diffEditor.showInlineChanges"),
		setting: booleanSetting("Inline change highlights", "Highlight the exact changed ranges within modified lines."),
	}),
	diffLoopChanges: configurationRegistry.registerConfiguration<boolean>({
		key: "diffEditor.loopChanges",
		defaultValue: true,
		parse: value => parseBoolean(value, "diffEditor.loopChanges"),
		setting: booleanSetting("Loop through changes", "Wrap change navigation from the final difference to the first."),
	}),
	diffBreadcrumbs: configurationRegistry.registerConfiguration<boolean>({
		key: "diffEditor.breadcrumbs.enabled",
		defaultValue: true,
		parse: value => parseBoolean(value, "diffEditor.breadcrumbs.enabled"),
		setting: booleanSetting("Change breadcrumbs", "Show the current change position while navigating a diff."),
	}),
	insertFinalNewLine: configurationRegistry.registerConfiguration<boolean>({
		key: "files.insertFinalNewline",
		defaultValue: false,
		parse: value => parseBoolean(value, "files.insertFinalNewline"),
		setting: booleanSetting("Insert final newline", "Ensure non-empty files end with a line feed when saved."),
	}),
});

export function getDiffComputationOptions(configuration: IConfigurationService): IDocumentDiffProviderOptions {
	return {
		ignoreTrimWhitespace: configuration.getValue<boolean>(CodeEditorConfiguration.diffIgnoreTrimWhitespace),
		maxComputationTimeMs: 0,
		computeMoves: false,
	};
}

function booleanSetting(title: string, description: string) {
	return { valueType: "boolean", title, description } as const;
}

function numberSetting(title: string, description: string, minimum: number, maximum: number) {
	return { valueType: "number", title, description, minimum, maximum } as const;
}

function selectSetting<T extends string>(title: string, description: string, options: readonly { readonly value: T; readonly label: string }[]) {
	return { valueType: "select", title, description, options } as const;
}

function textSetting(title: string, description: string, placeholder: string) {
	return { valueType: "text", title, description, placeholder } as const;
}

function parseBoolean(value: unknown, key: string): boolean {
	if (typeof value === "boolean") return value;
	throw new TypeError(`${key} must be a boolean; received ${String(value)}`);
}

function parseEnum<T extends string>(value: unknown, key: string, values: readonly T[]): T {
	if (typeof value === 'string' && values.includes(value as T)) return value as T;
	throw new TypeError(`${key} must be one of ${values.join(', ')}; received ${String(value)}`);
}

function parseNonNegativeInteger(value: unknown, key: string): number {
	if (Number.isSafeInteger(value) && (value as number) >= 0) return value as number;
	throw new RangeError(`${key} must be a non-negative integer; received ${String(value)}`);
}
