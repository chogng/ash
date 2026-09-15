import { createServiceIdentifier } from "../../platform/instantiation/common/instantiation.js";
import { type LanguageDiagnostic } from "../common/languages/languageResults.js";
import { type TextDecorationCollection } from "../common/model/decorationCollection.js";
import { type LanguageBracketPairs } from "../common/languages/languageBracketPairs.js";
import { type EditorFoldingModel } from "./folding/browser/foldingModel.js";
import { type LanguageStructuralBracketSource } from "../common/languages/languageLexicalContext.js";

/** Typed identities for shared runtime objects consumed by independently selected text-editor contributions. */
export const TextEditorCapability = Object.freeze({
	bracketPairs: createServiceIdentifier<LanguageBracketPairs>("editor.capability.bracketPairs"),
	diagnosticDecorations: createServiceIdentifier<TextDecorationCollection<LanguageDiagnostic>>("editor.capability.diagnosticDecorations"),
	folding: createServiceIdentifier<EditorFoldingModel>("editor.capability.folding"),
	languageLexicalContext: createServiceIdentifier<LanguageStructuralBracketSource>("editor.capability.languageLexicalContext"),
});
