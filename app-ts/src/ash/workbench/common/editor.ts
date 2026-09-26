import type { Event } from '../../base/common/event.js';
import type { Range } from '../../editor/common/core/range.js';
import type { TextEditorSelectionSource } from '../../platform/editor/common/editor.js';

export const enum EditorPaneSelectionChangeReason {
	PROGRAMMATIC = 1,
	USER,
	EDIT,
	NAVIGATION,
	JUMP,
}

/** Selection history capability shared by Workbench editor panes. */
export interface IEditorPaneWithSelection {
	readonly onDidChangeSelection: Event<EditorPaneSelectionChangeReason>;
	getSelection(): Range | undefined;
	restoreSelection(selection: Range, source: TextEditorSelectionSource): void;
}

export function isEditorPaneWithSelection(pane: unknown): pane is IEditorPaneWithSelection {
	const candidate = pane as IEditorPaneWithSelection | undefined;
	return typeof candidate?.onDidChangeSelection === 'function' && typeof candidate.getSelection === 'function' && typeof candidate.restoreSelection === 'function';
}
