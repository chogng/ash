import { createServiceIdentifier } from "../../../../src/ash/platform/instantiation/common/instantiation.js";
import { type LanguageDiagnostic } from '../../../../src/ash/editor/common/languages.js';
import { type TextDecorationCollection } from "../../../../src/ash/editor/common/model/decorationCollection.js";
import { type EditorFoldingModel } from "./folding/browser/foldingModel.js";

/** Typed identities for shared runtime objects consumed by independently selected text-editor contributions. */
export const TextEditorCapability = Object.freeze({
	diagnosticDecorations: createServiceIdentifier<TextDecorationCollection<LanguageDiagnostic>>("editor.capability.diagnosticDecorations"),
	folding: createServiceIdentifier<EditorFoldingModel>("editor.capability.folding"),
});
