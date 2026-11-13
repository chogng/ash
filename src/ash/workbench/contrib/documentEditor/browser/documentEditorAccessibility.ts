import type { IEditorPane } from '../../../common/editor.js';

/** Browser focus and readable content, independent of the document's format. */
export interface IDocumentAccessibleEditor extends IEditorPane {
	containsAccessibilityFocus(target: HTMLElement): boolean;
	getAccessibleContent(): string;
	getAccessibilityHelp(): readonly string[];
}

export function isDocumentAccessibleEditor(pane: IEditorPane | undefined): pane is IDocumentAccessibleEditor {
	const candidate = pane as Partial<IDocumentAccessibleEditor> | undefined;
	return typeof candidate?.containsAccessibilityFocus === 'function' && typeof candidate.getAccessibleContent === 'function' && typeof candidate.getAccessibilityHelp === 'function';
}
