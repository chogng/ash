import { registerColor, transparent } from "../colorUtils.js";
import {
	border as defaultBorder,
	descriptionForeground as baseDescriptionForeground,
	errorForeground,
	foreground,
	mutedForeground,
	selectionBackground,
	successForeground,
	widgetBorder as baseWidgetBorder,
	widgetShadow as baseWidgetShadow,
} from "./baseColors.js";
import {
	hoverBackground as componentHoverBackground,
	hoverBorder as componentHoverBorder,
	hoverForeground as componentHoverForeground,
} from "./componentColors.js";
import { inputBackground as defaultInputBackground } from "./inputColors.js";
import { listHoverBackground as defaultListHoverBackground } from "./listColors.js";

const owner = "editor.presentation";
const color = (id: string, dark: string, light: string, description: string): string => registerColor(id, { dark, light }, { description, owner });
const alias = (id: string, value: string, description: string): string => registerColor(id, { dark: value, light: value }, { description, owner });

export const editorBackground = registerColor("editor.background", {
	dark: "#1e1e1e", light: "#ffffff",
	highContrastDark: "#1e1e1e", highContrastLight: "#ffffff",
}, { description: "Editor background.", owner });
export const editorForeground = registerColor("editor.foreground", {
	dark: "#d4d4d4", light: "#333333",
	highContrastDark: "#d4d4d4", highContrastLight: "#333333",
}, { description: "Editor foreground.", owner });

export const tokenCommentForeground = color("editor.token.commentForeground", "#6a9955", "#008000", "Foreground for comment tokens independently of their syntax or semantic source.");
export const tokenKeywordForeground = color("editor.token.keywordForeground", "#c586c0", "#af00db", "Foreground for keyword tokens independently of their syntax or semantic source.");
export const tokenStringForeground = color("editor.token.stringForeground", "#ce9178", "#a31515", "Foreground for string tokens independently of their syntax or semantic source.");
export const tokenNumberForeground = color("editor.token.numberForeground", "#b5cea8", "#098658", "Foreground for number tokens independently of their syntax or semantic source.");
export const tokenRegexpForeground = color("editor.token.regexpForeground", "#d16969", "#811f3f", "Foreground for regular-expression tokens independently of their syntax or semantic source.");
export const tokenTypeForeground = color("editor.token.typeForeground", "#4ec9b0", "#267f99", "Foreground for type tokens independently of their syntax or semantic source.");
export const tokenFunctionForeground = color("editor.token.functionForeground", "#dcdcaa", "#795e26", "Foreground for function tokens independently of their syntax or semantic source.");
export const tokenVariableForeground = alias("editor.token.variableForeground", foreground, "Foreground for variable tokens independently of their syntax or semantic source.");
export const tokenOperatorForeground = alias("editor.token.operatorForeground", foreground, "Foreground for operator tokens independently of their syntax or semantic source.");
export const tokenAttributeForeground = alias("editor.token.attributeForeground", tokenVariableForeground, "Foreground for attribute tokens.");
export const tokenConstantForeground = alias("editor.token.constantForeground", tokenNumberForeground, "Foreground for constant tokens.");
export const tokenConstructorForeground = alias("editor.token.constructorForeground", tokenTypeForeground, "Foreground for constructor tokens.");
export const tokenEmbeddedForeground = alias("editor.token.embeddedForeground", foreground, "Foreground for embedded-language tokens.");
export const tokenLabelForeground = alias("editor.token.labelForeground", tokenKeywordForeground, "Foreground for label tokens.");
export const tokenModuleForeground = alias("editor.token.moduleForeground", tokenTypeForeground, "Foreground for module and namespace tokens.");
export const tokenPropertyForeground = alias("editor.token.propertyForeground", tokenVariableForeground, "Foreground for property tokens.");
export const tokenPunctuationForeground = alias("editor.token.punctuationForeground", tokenOperatorForeground, "Foreground for punctuation tokens.");

export const border = alias("editor.border", defaultBorder, "Editor surface border.");
export const widgetBackground = color("editor.widgetBackground", "#252526", "#f3f3f3", "Background for floating editor widgets.");
export const widgetBorder = alias("editor.widgetBorder", baseWidgetBorder, "Border around floating editor widgets.");
export const widgetShadow = alias("editor.widgetShadow", baseWidgetShadow, "Shadow around floating editor widgets.");
export const inputBackground = alias("editor.inputBackground", defaultInputBackground, "Background for editor widget inputs.");
export const listHoverBackground = alias("editor.listHoverBackground", defaultListHoverBackground, "Hover background for editor widget lists.");
export const descriptionForeground = alias("editor.descriptionForeground", baseDescriptionForeground, "Foreground for editor widget descriptions.");
export const hoverForeground = alias("editor.hoverForeground", componentHoverForeground, "Foreground for editor Hovers.");
export const hoverBackground = alias("editor.hoverBackground", componentHoverBackground, "Background for editor Hovers.");
export const hoverBorder = alias("editor.hoverBorder", componentHoverBorder, "Border around editor Hovers.");
export const inlayHintForeground = alias("editor.inlayHintForeground", mutedForeground, "Foreground for editor inlay hints.");
export const inlineCompletionForeground = alias("editor.inlineCompletionForeground", mutedForeground, "Foreground for inline completions.");
export const compositionBorder = color("editor.compositionBorder", "#a0a0a0", "#a0a0a0", "Border under text in an active input method composition.");
export const foldBackground = registerColor(
	'editor.foldBackground',
	{ dark: transparent(selectionBackground, 0.3), light: transparent(selectionBackground, 0.3), highContrastDark: null, highContrastLight: null },
	{ description: 'Background behind collapsed editor ranges.', owner, needsTransparency: true },
);
export const foldPlaceholderForeground = color('editor.foldPlaceholderForeground', '#808080', '#808080', 'Foreground for the collapsed-range placeholder.');
export const foldingControlForeground = alias('editorGutter.foldingControlForeground', foreground, 'Foreground for editor folding controls.');

export const diffRemovedLineBackground = color("diffEditor.removedLineBackground", "#4b1818", "#ffebe9", "Background for removed diff lines.");
export const diffInsertedLineBackground = color("diffEditor.insertedLineBackground", "#173d24", "#dafbe1", "Background for inserted diff lines.");
export const diffRemovedTextBackground = color("diffEditor.removedTextBackground", "#7d2020", "#ffc6c2", "Background for removed inline diff ranges.");
export const diffInsertedTextBackground = color("diffEditor.insertedTextBackground", "#1f6f35", "#a6ebb7", "Background for inserted inline diff ranges.");
export const diffMissingLineBackground = color("diffEditor.missingLineBackground", "#202020", "#f8f8f9", "Background for a diff side without a corresponding source line.");
export const diffUnchangedRegionBackground = color("diffEditor.unchangedRegionBackground", "#1f2933", "#f1f6fc", "Background for collapsed unchanged diff regions.");
export const diffUnchangedRegionForeground = alias("diffEditor.unchangedRegionForeground", mutedForeground, "Foreground for collapsed unchanged diff regions.");
export const diffRemovedLineMarker = alias("diffEditor.removedLineMarker", errorForeground, "Marker foreground for removed diff lines.");
export const diffInsertedLineMarker = alias("diffEditor.insertedLineMarker", successForeground, "Marker foreground for inserted diff lines.");

const legacy = (id: string, value: string, description: string): string => registerColor(id, { dark: value, light: value }, { deprecated: "Use the corresponding editor.token.* token.", description, owner });
export const semanticTokenCommentForeground = legacy("editor.semanticToken.commentForeground", tokenCommentForeground, "Compatibility alias for comment token foreground.");
export const semanticTokenKeywordForeground = legacy("editor.semanticToken.keywordForeground", tokenKeywordForeground, "Compatibility alias for keyword token foreground.");
export const semanticTokenStringForeground = legacy("editor.semanticToken.stringForeground", tokenStringForeground, "Compatibility alias for string token foreground.");
export const semanticTokenNumberForeground = legacy("editor.semanticToken.numberForeground", tokenNumberForeground, "Compatibility alias for number token foreground.");
export const semanticTokenRegexpForeground = legacy("editor.semanticToken.regexpForeground", tokenRegexpForeground, "Compatibility alias for regular-expression token foreground.");
export const semanticTokenTypeForeground = legacy("editor.semanticToken.typeForeground", tokenTypeForeground, "Compatibility alias for type token foreground.");
export const semanticTokenFunctionForeground = legacy("editor.semanticToken.functionForeground", tokenFunctionForeground, "Compatibility alias for function token foreground.");
export const semanticTokenVariableForeground = legacy("editor.semanticToken.variableForeground", tokenVariableForeground, "Compatibility alias for variable token foreground.");
export const semanticTokenOperatorForeground = legacy("editor.semanticToken.operatorForeground", tokenOperatorForeground, "Compatibility alias for operator token foreground.");
