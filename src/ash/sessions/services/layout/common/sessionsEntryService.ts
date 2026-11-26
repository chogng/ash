import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IObservable } from '../../../../base/common/observable.js';
import type { SessionsConversationKind } from '../../sessions/common/sessionsConversation.js';
import type { EditorOpenTarget, EditorReplacementTarget } from '../../../../workbench/services/editor/common/editorService.js';

/** Features describe their shared hosts; resource categories and workspace models stay with the feature. */
export interface ISessionsEntry {
	readonly id: string;
	/** Shared entries retain the current workspace mode, including on restoration. */
	readonly workspaceMode?: 'chat' | 'code' | 'current';
	readonly activityContext: string;
	readonly content: 'conversation' | 'documents' | 'editor';
	/** Selects a renderer for entries that host the session grid directly. */
	readonly conversationKind?: SessionsConversationKind;
	/** Model source registered with the Chat view factory. */
	readonly chatSource?: string;
	/** Stable, source-owned conversation identity for the optional browser working set. */
	readonly browserContext?: IObservable<string>;
	/** Selects this document's own conversation or a separate empty draft before revealing its editor. */
	readonly openDocumentConversation?: (resource: URI, signal: AbortSignal) => Promise<void>;
	/** Places the ordinary Chat view beside this editor and sets its initial visibility. */
	readonly conversation?: 'visible' | 'optional';
	/** Overrides workspace navigation; omission uses the workspace sidebar or its registered default. */
	readonly sidebarContainerId?: string;
	/** Whether this entry allows the title bar workspace mode control. Defaults to true. */
	readonly showWorkspaceModeControl?: boolean;
	readonly showEditorTabs?: boolean;
	/** An editor entry docks this view container in its EditorPart. */
	readonly detailsContainerId?: string;
	readonly showDetailsByDefault?: boolean;
	readonly editorInput?: IResourceEditorInput;
	/** Update feature-owned restoration state after Save As changes the resource. */
	readonly onEditorInputReplaced?: (input: IResourceEditorInput, replacement: IResourceEditorInput) => void;
	readonly restoreCommand: string;
	/** Routes the window's New action to this entry's own conversation owner. */
	readonly newSessionCommand?: string;
	/** Use the shared conversation Part's draft state or supply the state of an entry-owned composer. */
	readonly newDraft?: 'conversation' | IObservable<boolean>;
	readonly focus: 'conversation' | 'sidebar' | 'editor';
}

export interface ISessionsEntryOpenOptions {
	readonly source?: 'restore' | 'startup';
	readonly focus?: 'conversation';
}

export interface ISessionsEntryService extends IDisposable {
	/** The committed browser working-set identity; undefined outside a supported Chat entry. */
	readonly conversationBrowserContext: IObservable<string | undefined>;
	/** Browser tabs retained beside the active compact Chat entry. */
	readonly conversationEditors: readonly IResourceEditorInput[];
	isConversationEditor(resource: URI, activeOnly?: boolean): boolean;
	/** Keeps browser creation and editor opening inside the active Chat composition transaction. */
	openConversationBrowser(open: (target: EditorOpenTarget) => Promise<void>, replace?: EditorReplacementTarget): Promise<void>;
	/** Opens a picked file in the current workspace and replaces its launcher tab. */
	openToolFile(resource: URI, replace: EditorReplacementTarget): Promise<void>;
	/** Opens a project document beside Chat and returns focus to its sidebar row on close. */
	openConversationFile(input: IResourceEditorInput, restoreFocus: () => void, signal: AbortSignal): Promise<void>;
	/** Closes one tab in the current conversation through its owning editor group. */
	closeConversationEditor(input: IResourceEditorInput): Promise<void>;
	/** Saves the restored editor layout after startup attaches retained tool editors. */
	checkpointEditorLayout(): Promise<void>;
	readonly newSessionCommand?: string;
	setConversationVisible(visible: boolean, options?: { readonly preserveFocus?: boolean; }): Promise<void>;
	/** Initialize retained content after its editor is created and when history revisits the entry. Restoration preserves any covering Custom View and its focus. */
	openEntry(entry: ISessionsEntry, initialize?: () => ISessionsEntry, options?: ISessionsEntryOpenOptions): Promise<void>;
	replaceEditorResource(sourceGroupId: number, input: IResourceEditorInput, replacement: IResourceEditorInput): Promise<void>;
	restore(): Promise<void>;
}

export const ISessionsEntryService = createServiceIdentifier<ISessionsEntryService>('sessionsEntryService');
