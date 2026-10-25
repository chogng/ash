import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { Event } from '../../../../base/common/event.js';

/** Features describe their shared hosts; resource categories and workspace models stay with the feature. */
export interface ISessionsEntry {
	readonly id: string;
	readonly workspaceMode?: 'chat' | 'code';
	readonly activityContext: string;
	readonly content: 'conversation' | 'documents' | 'editor';
	/** Starts hidden on entry; user actions may reveal the shared conversation without replacing the editor or side views. */
	readonly conversation?: 'optional';
	/** Overrides the shared Sessions navigation content; omission preserves the window sidebar. */
	readonly sidebarContainerId?: string;
	readonly showEditorTabs?: boolean;
	readonly detailsContainerId?: string;
	readonly editorInput?: IResourceEditorInput;
	readonly restoreCommand: string;
	/** Routes the window's New action to this entry's own conversation owner. */
	readonly newSessionCommand?: string;
	readonly focus: 'conversation' | 'sidebar' | 'editor';
}

export interface ISessionsLayoutService extends IDisposable {
	readonly newSessionCommand?: string;
	readonly conversationVisible: boolean;
	readonly onDidChangeConversationVisibility: Event<void>;
	setConversationVisible(visible: boolean): Promise<void>;
	/** Initialize retained content after its editor is created. Restoration preserves any covering Custom View and its focus. */
	openEntry(entry: ISessionsEntry, initialize?: () => ISessionsEntry, options?: { readonly source: 'restore'; }): Promise<void>;
	restore(): Promise<void>;
}

export const ISessionsLayoutService = createServiceIdentifier<ISessionsLayoutService>('sessionsLayoutService');
