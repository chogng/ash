import { ContextKeyExpr, RawContextKey } from '../../platform/contextkey/common/contextkey.js';

export namespace EditorContextKeys {
	export const standaloneColorPickerVisible = new RawContextKey<boolean>('standaloneColorPickerVisible', false);
	export const standaloneColorPickerFocused = new RawContextKey<boolean>('standaloneColorPickerFocused', false);
	export const stickyScrollFocused = new RawContextKey<boolean>('stickyScrollFocused', false);
	export const stickyScrollVisible = new RawContextKey<boolean>('stickyScrollVisible', false);
	export const hasRenameProvider = new RawContextKey<boolean>('editorHasRenameProvider', false);
	export const hasDefinitionProvider = new RawContextKey<boolean>('editorHasDefinitionProvider', false);
	export const hasDeclarationProvider = new RawContextKey<boolean>('editorHasDeclarationProvider', false);
	export const hasTypeDefinitionProvider = new RawContextKey<boolean>('editorHasTypeDefinitionProvider', false);
	export const hasImplementationProvider = new RawContextKey<boolean>('editorHasImplementationProvider', false);
	export const hasReferenceProvider = new RawContextKey<boolean>('editorHasReferenceProvider', false);
	export const hasCallHierarchyProvider = new RawContextKey<boolean>('editorHasCallHierarchyProvider', false);
	export const hasTypeHierarchyProvider = new RawContextKey<boolean>('editorHasTypeHierarchyProvider', false);
	export const hasCodeActionsProvider = new RawContextKey<boolean>('editorHasCodeActionsProvider', false);
	export const hasSignatureHelpProvider = new RawContextKey<boolean>('editorHasSignatureHelpProvider', false);
	export const hasDocumentFormattingProvider = new RawContextKey<boolean>('editorHasDocumentFormattingProvider', false);
	export const hasDocumentSelectionFormattingProvider = new RawContextKey<boolean>('editorHasDocumentSelectionFormattingProvider', false);
	export const editorSimpleInput = new RawContextKey<boolean>('editorSimpleInput', false);
	export const editorTextFocus = new RawContextKey<boolean>('editorTextFocus', false);
	export const focus = new RawContextKey<boolean>('editorFocus', false);
	export const textInputFocus = new RawContextKey<boolean>('textInputFocus', false);
	export const readOnly = new RawContextKey<boolean>('editorReadonly', false);
	export const writable = ContextKeyExpr.not(readOnly.key);
	export const hasNonEmptySelection = new RawContextKey<boolean>('editorHasSelection', false);
	export const hasMultipleSelections = new RawContextKey<boolean>('editorHasMultipleSelections', false);
	export const isComposing = new RawContextKey<boolean>('isComposing', false);
	export const languageId = new RawContextKey<string>('editorLangId', '');
}
