import type { Event } from '../../base/common/event.js';
import type { Range } from '../../editor/common/core/range.js';
import type { TextEditorSelectionSource } from '../../platform/editor/common/editor.js';
import type { IAction } from '../../base/common/actions.js';
import { toError } from '../../base/common/errors.js';
import type Severity from '../../base/common/severity.js';

/** Input-owned restrictions enforced consistently by editor commands and tabs. */
export const enum EditorInputCapabilities {
	None = 0,
	CannotClose = 1 << 13,
}

export interface IEditorOpenErrorOptions {
	/** Uses the supplied message as the page heading instead of a generic open failure. */
	forceMessage?: boolean;
	forceSeverity?: Severity;
	/** Allows a dialog for an explicit user open; automatic restoration stays in the editor. */
	allowDialog?: boolean;
}

export interface IEditorOpenError extends Error, IEditorOpenErrorOptions {
	readonly actions: readonly IAction[];
}

export function isEditorOpenError(error: unknown): error is IEditorOpenError {
	return error instanceof Error && Array.isArray((error as IEditorOpenError).actions);
}

export function createEditorOpenError(messageOrError: string | Error, actions: IAction[], options: IEditorOpenErrorOptions = {}): IEditorOpenError {
	return Object.assign(toError(messageOrError), options, { actions });
}

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
