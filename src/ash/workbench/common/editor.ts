import type { IEditorGroup } from '../services/editor/common/editorGroupsService.js';
import type { IEditorOptions } from '../../platform/editor/common/editor.js';
import type { ThemeIcon } from '../../base/common/themables.js';
import type { Event } from '../../base/common/event.js';
import type { Range } from '../../editor/common/core/range.js';
import type { TextEditorSelectionSource } from '../../platform/editor/common/editor.js';
import type { IAction } from '../../base/common/actions.js';
import { toError } from '../../base/common/errors.js';
import type Severity from '../../base/common/severity.js';
import { URI } from '../../base/common/uri.js';
import type { IDisposable } from '../../base/common/lifecycle.js';
import type { ISize } from '../../base/common/layout.js';
import type { IComposite, ICompositeControl } from './composite.js';
import type { IWorkingCopy } from '../services/workingCopy/common/workingCopyService.js';
import type { IEditorCloseHandler } from './editor/editorInput.js';

/** Format-specific control exposed by a Workbench editor pane. */
export interface IEditorControl extends ICompositeControl { }

/** A version-bound, package-defined editor operation. No model or service escapes this port. */
export interface IEditorExtensionApi {
	/** Document version captured by this handle; a later edit requires a fresh handle. */
	readonly version: number;
	readonly readOnly: boolean;
	/** The owning editor validates the opaque request and cancellation before committing. */
	invoke(payload: unknown, signal: AbortSignal): Promise<unknown>;
}

/** One retained editor implementation; its host owns creation, visibility and disposal. */
export interface IEditorPane extends IComposite, IDisposable {
	readonly id: string;
	readonly group?: IEditorGroup;
	/** Tools with their own document controls can omit the group header when they are its only editor. */
	readonly prefersEditorTitleHidden?: boolean;
	/** Tools can omit their auxiliary window's status bar while active. */
	readonly prefersStatusbarHidden?: boolean;
	/** Dedicated tools can replace auxiliary workbench actions with compact window controls. */
	readonly prefersCompactTitlebar?: boolean;
	readonly workingCopy?: IWorkingCopy;
	/** File-owned copies retained by an editor that displays multiple resources. */
	getWorkingCopies?(): readonly IWorkingCopy[];
	readonly onDidChangeWorkingCopies?: Event<void>;
	getControl(): IEditorControl | undefined;
	getExtensionApi?(id: string): IEditorExtensionApi | undefined;
	setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void>;
	setOptions?(options: IEditorOptions): void;
	clearInput(): void;
	layout(dimension: ISize): void;
	setVisible(visible: boolean): void;
	isVisible(): boolean;
	revealRange?(range: Range): void;
	save?(options?: ISaveOptions): Promise<void>;
	/** Custom drafts own naming and return their saved replacement, or undefined when cancelled. */
	saveDraft?(): Promise<IResourceEditorInput | undefined>;
	saveAs?(resource: URI): Promise<void>;
}

export interface IEditorPaneScrollPosition {
	readonly scrollTop: number;
	readonly scrollLeft?: number;
}

export interface IEditorPaneWithScrolling extends IEditorPane {
	readonly onDidChangeScroll: Event<void>;
	getScrollPosition(): IEditorPaneScrollPosition;
	setScrollPosition(position: IEditorPaneScrollPosition): void;
}

export function isEditorPaneWithScrolling(pane: IEditorPane | undefined): pane is IEditorPaneWithScrolling {
	const candidate = pane as Partial<IEditorPaneWithScrolling> | undefined;
	return typeof candidate?.onDidChangeScroll === 'function'
		&& typeof candidate.getScrollPosition === 'function'
		&& typeof candidate.setScrollPosition === 'function';
}

export function getEditorWorkingCopies(pane: IEditorPane): readonly IWorkingCopy[] {
	return pane.getWorkingCopies?.() ?? (pane.workingCopy ? [pane.workingCopy] : []);
}

export interface EditorPaneStatus {
	readonly lineNumber?: number;
	readonly columnNumber?: number;
	readonly selectionCount?: number;
	readonly languageId?: string;
	readonly encoding?: string;
	readonly endOfLine?: string;
}

export interface IEditorPaneWithStatus extends IEditorPane {
	readonly onDidChangeStatus: Event<void>;
	getStatus(): EditorPaneStatus;
}

export function isEditorPaneWithStatus(pane: IEditorPane | undefined): pane is IEditorPaneWithStatus {
	const candidate = pane as Partial<IEditorPaneWithStatus> | undefined;
	return typeof candidate?.onDidChangeStatus === 'function' && typeof candidate.getStatus === 'function';
}

export enum SaveReason {
	EXPLICIT = 1,
	AUTO = 2,
	FOCUS_CHANGE = 3,
	WINDOW_CHANGE = 4,
}

export interface ISaveOptions {
	readonly writeElevated?: boolean;
	/** Explicit retry that makes an existing file writable without system elevation. */
	readonly unlock?: boolean;
	readonly reason?: SaveReason;
	readonly skipSaveParticipants?: boolean;
}

export interface IEditorIdentifier {
	readonly editor: IResourceEditorInput;
	readonly groupId: number;
}

/** A resource requested through the Workbench editor service. */
export interface IResourceEditorInput {
	readonly closeHandler?: IEditorCloseHandler;
	/** Distinguishes an independent custom editor tab from a text tab for the same resource. */
	readonly editorId?: string;
	toUntyped?(): IResourceEditorInput;
	/** A custom editor can veto transfers before its source window is closed. */
	canMove?(sourceGroup: number, targetGroup: number): true | string;
	readonly capabilities?: EditorInputCapabilities;
	readonly resource: URI;
	/** Resource used for labels and navigation while resource retains content identity. */
	readonly preferredResource?: URI;
	readonly contentType?: string;
	readonly languageId?: string;
	readonly label?: string;
	/** Also signals a change to the editor's custom icon. */
	readonly onDidChangeLabel?: Event<void>;
	getIcon?(): ThemeIcon | URI | undefined;
	/** Styling belongs to the input's product while the shared tabs own label rendering. */
	getLabelExtraClasses?(): readonly string[];
	readonly readOnly?: boolean;
	/** Whether the resource path is meaningful to show as breadcrumbs. */
	readonly showBreadcrumbs?: boolean;
	readonly initialText?: string;
	/** Immutable bytes for a read-only version whose resource has no filesystem provider. */
	readonly initialBytes?: Uint8Array;
	readonly encoding?: string;
}

/** Comparison inputs keep a tab identity separate from the resources displayed on each side. */
export interface IResourceDiffEditorInput {
	readonly original: IResourceEditorInput;
	readonly modified: IResourceEditorInput;
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
	public getOriginalUri(editor: IResourceEditorInput | undefined | null, options?: IEditorResourceAccessorOptions & { supportSideBySide?: SideBySideEditor.PRIMARY | SideBySideEditor.SECONDARY | SideBySideEditor.ANY; }): URI | undefined;
	public getOriginalUri(editor: IResourceEditorInput | undefined | null, options: IEditorResourceAccessorOptions & { supportSideBySide: SideBySideEditor.BOTH; }): URI | { primary?: URI; secondary?: URI; } | undefined;
	public getOriginalUri(editor: IResourceEditorInput | undefined | null, options: IEditorResourceAccessorOptions): URI | { primary?: URI; secondary?: URI; } | undefined;
	public getOriginalUri(editor: IResourceEditorInput | undefined | null, options: IEditorResourceAccessorOptions = {}): URI | { primary?: URI; secondary?: URI; } | undefined {
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
		const resource = editor.preferredResource ?? editor.resource;
		const filter = options.filterByScheme;
		return filter === undefined || (typeof filter === 'string' ? filter === resource.scheme : filter.includes(resource.scheme)) ? resource : undefined;
	}
}

/** Resolves display and command resources without changing a compound tab's identity. */
export const EditorResourceAccessor = new EditorResourceAccessorImpl();

/** Input-owned restrictions enforced consistently by editor commands and tabs. */
export const enum EditorInputCapabilities {
	None = 0,
	/** The input owns one window canvas and cannot be copied into another group. */
	Singleton = 1 << 3,
	ExcludeFromEditorLimit = 1 << 12,
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
export interface IEditorPaneWithSelection extends IEditorPane {
	readonly onDidChangeSelection: Event<EditorPaneSelectionChangeReason>;
	getSelection(): Range | undefined;
	restoreSelection(selection: Range, source: TextEditorSelectionSource): void;
}

export function isEditorPaneWithSelection(pane: unknown): pane is IEditorPaneWithSelection {
	const candidate = pane as IEditorPaneWithSelection | undefined;
	return typeof candidate?.onDidChangeSelection === 'function' && typeof candidate.getSelection === 'function' && typeof candidate.restoreSelection === 'function';
}
