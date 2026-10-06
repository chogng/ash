import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { EditorInput } from '../../../../workbench/services/editor/common/editorService.js';

/** Features describe their shared hosts; resource categories and workspace models stay with the feature. */
export interface ISessionsEntry {
	readonly id: string;
	readonly activityContext: string;
	readonly content: 'conversation' | 'documents' | 'editor';
	readonly sidebarContainerId: string;
	readonly detailsContainerId?: string;
	readonly editorInput?: EditorInput;
	readonly restoreCommand: string;
	readonly focus: 'conversation' | 'sidebar' | 'editor';
}

export interface ISessionsLayoutService {
	/** Initialize retained feature content after its editor is created, before changing the surrounding hosts. */
	openEntry(entry: ISessionsEntry, initialize?: () => ISessionsEntry): Promise<void>;
	restore(): Promise<void>;
}

export const ISessionsLayoutService = createServiceIdentifier<ISessionsLayoutService>('sessionsLayoutService');
