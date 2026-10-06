import type { Event } from '../../base/common/event.js';
import type { Range } from '../../editor/common/core/range.js';
import type { TextEditorSelectionSource } from '../../platform/editor/common/editor.js';
import type { IAction } from '../../base/common/actions.js';
import { toError } from '../../base/common/errors.js';
import type Severity from '../../base/common/severity.js';
import { URI } from '../../base/common/uri.js';
import type { EditorInput } from '../services/editor/common/editorService.js';

/** Comparison inputs keep a tab identity separate from the resources displayed on each side. */
export interface IResourceDiffEditorInput {
	readonly original: EditorInput;
	readonly modified: EditorInput;
}

export function isResourceDiffEditorInput(input: unknown): input is IResourceDiffEditorInput {
	const candidate = input as Partial<IResourceDiffEditorInput> | undefined;
	return URI.isUri(candidate?.original?.resource) && URI.isUri(candidate?.modified?.resource);
}

export const BINARY_DIFF_EDITOR_ID = 'ash.editor.binaryDiff';

export enum SideBySideEditor {
	PRIMARY = 1,
	SECONDARY = 2,
	BOTH = 3,
	ANY = 4,
}

export interface IEditorResourceAccessorOptions {
	/** Compound inputs expose file resources only when the caller selects their sides. */
	readonly supportSideBySide?: SideBySideEditor;
	readonly filterByScheme?: string | readonly string[];
}

class EditorResourceAccessorImpl {
	public getOriginalUri(editor: EditorInput | undefined | null, options?: IEditorResourceAccessorOptions & { supportSideBySide?: SideBySideEditor.PRIMARY | SideBySideEditor.SECONDARY | SideBySideEditor.ANY; }): URI | undefined;
	public getOriginalUri(editor: EditorInput | undefined | null, options: IEditorResourceAccessorOptions & { supportSideBySide: SideBySideEditor.BOTH; }): URI | { primary?: URI; secondary?: URI; } | undefined;
	public getOriginalUri(editor: EditorInput | undefined | null, options: IEditorResourceAccessorOptions): URI | { primary?: URI; secondary?: URI; } | undefined;
	public getOriginalUri(editor: EditorInput | undefined | null, options: IEditorResourceAccessorOptions = {}): URI | { primary?: URI; secondary?: URI; } | undefined {
		if (!editor) {
			return undefined;
		}
		if (isResourceDiffEditorInput(editor)) {
			if (options.supportSideBySide === undefined) {
				return undefined;
			}
			if (options.supportSideBySide === SideBySideEditor.BOTH) {
				const sideOptions = { ...options, supportSideBySide: SideBySideEditor.PRIMARY as const };
				return { primary: this.getOriginalUri(editor.modified, sideOptions), secondary: this.getOriginalUri(editor.original, sideOptions) };
			}
			if (options.supportSideBySide === SideBySideEditor.ANY) {
				const sideOptions = { ...options, supportSideBySide: SideBySideEditor.PRIMARY as const };
				return this.getOriginalUri(editor.modified, sideOptions) ?? this.getOriginalUri(editor.original, sideOptions);
			}
			return this.getOriginalUri(options.supportSideBySide === SideBySideEditor.SECONDARY ? editor.original : editor.modified, options);
		}
		const filter = options.filterByScheme;
		return filter === undefined || (typeof filter === 'string' ? filter === editor.resource.scheme : filter.includes(editor.resource.scheme)) ? editor.resource : undefined;
	}
}

/** Resolves display and command resources without changing a compound tab's identity. */
export const EditorResourceAccessor = new EditorResourceAccessorImpl();

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
