import type { IResourceEditorInput, IEditorPane, IEditorIdentifier } from '../../../common/editor.js';
import type { IDimension } from '../../../../base/browser/dom.js';
import type { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import type { EditorOpenOptions } from '../../../services/editor/common/editorService.js';
import type { EditorGroupId, EditorIdentifier, EditorInstanceId } from '../../../services/editor/common/editorState.js';
import type { SerializedEditorViewState } from '../../../services/editor/common/editorWorkingSet.js';
import type { ISaveEditorsOptions } from '../../../services/editor/common/editorService.js';
import type { MenuId } from '../../../../platform/actions/common/actions.js';
import type { Event } from '../../../../base/common/event.js';
import type { IObservable } from '../../../../base/common/observable.js';

/** Menu locations supplied by the product hosting an editor group. */
export interface IEditorGroupMenuIds {
	readonly headerPrimary?: MenuId;
	readonly headerLayout?: MenuId;
	readonly editorActions?: MenuId;
	readonly tabsBarAddTab?: MenuId;
}

export interface IEditorGroupViewOptions {
	readonly menuIds?: IEditorGroupMenuIds;
	/** Primary command for Add Tab when the group supplies a launcher editor. */
	readonly addTabCommand?: string;
	readonly showHeader?: boolean;
	/** Whether to keep the group header below tabs hosted in the window title bar. */
	readonly showHeaderFor?: (editor: IResourceEditorInput | undefined) => boolean;
	/** Host the active editor's dedicated toolbar alongside the group actions. */
	readonly showEditorToolbar?: boolean;
	/** Label for a visible group header with no editor and no tabs. */
	readonly emptyHeaderLabel?: string;
	readonly headerRowHeight?: IObservable<number | undefined>;
}

/** Shared presentation marker for editor tabs connected to their pane. */
export const CONNECTED_EDITOR_TABS_CLASS = 'ash-connected-editor-tabs';
export const CONNECTED_EDITOR_TABS_SELECTOR = `.${CONNECTED_EDITOR_TABS_CLASS}`;

/** Browser host capabilities used by editor parts, separate from command operations. */
export interface IEditorGroupView extends IEditorGroup {
	readonly domNode: HTMLElement;
	readonly activePane: IEditorPane | undefined;
	readonly activeEditor: EditorIdentifier | undefined;
	getEditorIdentifier(instanceId: EditorInstanceId): EditorIdentifier | undefined;
	saveEditor(input: IResourceEditorInput, options?: ISaveEditorsOptions): Promise<IResourceEditorInput | undefined>;
	saveEditorViewState(input: IResourceEditorInput): SerializedEditorViewState | undefined;
	restoreEditorViewState(input: IResourceEditorInput, state: SerializedEditorViewState | undefined): boolean;
	/** An open for a move rejects on failure even when it displays an error page. */
	openEditor(input: IResourceEditorInput, options?: EditorOpenOptions, transferredInstanceId?: EditorInstanceId): Promise<IEditorPane>;
	reopenEditorWith(input: IResourceEditorInput, preferredEditorId: string, preserveFocus?: boolean): Promise<IEditorPane | undefined>;
	getEditorPane(input: IResourceEditorInput): IEditorPane | undefined;
	activateEditor(input: IResourceEditorInput): IEditorPane;
	confirmCloseEditor(input: IResourceEditorInput, closingGroups?: readonly EditorGroupId[], closingEditors?: readonly IEditorIdentifier[]): Promise<boolean>;
	replaceEditor(input: IResourceEditorInput, replacement: IResourceEditorInput): Promise<void>;
	moveEditorTo(input: IResourceEditorInput, target: IEditorGroupView, targetIndex: number): Promise<void>;
	setContent(content: Element): Promise<boolean>;
	setTitleVisible(visible: boolean): void;
	readonly onDidChange: Event<void>;
	/** Space needed to present the active tab and adjoining controls in one row. */
	readonly singleRowTabStripSize: IDimension | undefined;
	setTabStripHost(host: HTMLElement | undefined): void;
	containsFocus(element: Element | null): boolean;
	layout(dimension: IDimension): void;
}
