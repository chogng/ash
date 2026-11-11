import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IObservable } from '../../../../base/common/observable.js';
import type { SessionsConversationKind } from '../../sessions/common/sessionsConversation.js';

/** Features describe their shared hosts; resource categories and workspace models stay with the feature. */
export interface ISessionsEntry {
	readonly id: string;
	/** Shared entries retain the current workspace mode, including on restoration. */
	readonly workspaceMode?: 'chat' | 'code' | 'current';
	readonly activityContext: string;
	readonly content: 'conversation' | 'documents' | 'editor';
	/** A conversation entry can select a renderer independently of its workspace mode. */
	readonly conversationKind?: SessionsConversationKind;
	/** Model source registered with the Chat view factory. */
	readonly chatSource?: string;
	/** Whether the shared conversation starts visible beside this editor. */
	readonly conversation?: 'visible' | 'optional';
	/** Overrides workspace navigation; omission retains its current sidebar or opens the registered default on startup. */
	readonly sidebarContainerId?: string;
	/** Whether this entry allows the title bar workspace mode control. Defaults to true. */
	readonly showWorkspaceModeControl?: boolean;
	readonly showEditorTabs?: boolean;
	/** An editor entry docks this view container in its EditorPart. */
	readonly detailsContainerId?: string;
	readonly editorInput?: IResourceEditorInput;
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
	/** Saves the restored editor layout after startup attaches retained tool editors. */
	checkpointEditorLayout(): Promise<void>;
	readonly newSessionCommand?: string;
	setConversationVisible(visible: boolean): Promise<void>;
	/** Initialize retained content after its editor is created. Restoration preserves any covering Custom View and its focus. */
	openEntry(entry: ISessionsEntry, initialize?: () => ISessionsEntry, options?: ISessionsEntryOpenOptions): Promise<void>;
	restore(): Promise<void>;
}

export const ISessionsEntryService = createServiceIdentifier<ISessionsEntryService>('sessionsEntryService');
