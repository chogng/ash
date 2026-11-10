import type { URI } from '../../../base/common/uri.js';
import type { Event } from '../../../base/common/event.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

/** Project text and source references that never grant file access. */
export type ProjectMaterial =
	| { readonly kind: 'file'; readonly name: string; readonly resource: URI; readonly sizeBytes: number; }
	| { readonly kind: 'folder'; readonly name: string; readonly resource: URI; }
	| { readonly kind: 'text'; readonly id: string; readonly name: string; readonly content: string; };

export interface ProjectAppearance {
	readonly icon?: string;
	readonly color?: string;
}

export interface ProjectSummary extends ProjectAppearance {
	readonly id: string;
	readonly revision: number;
	/** Unix epoch milliseconds; undefined for older projects whose time is unknown. */
	readonly createdAtMs?: number;
	readonly updatedAtMs?: number;
	readonly name: string;
	readonly archived: boolean;
	readonly sessionCount: number;
}

export interface Project extends ProjectSummary {
	readonly description: string;
	readonly roots?: readonly URI[];
	readonly materials: readonly ProjectMaterial[];
	readonly sessionIds: readonly string[];
	readonly externalConversationIds?: readonly string[];
}

export type ProjectScope = 'chat' | 'code';

/** The backend owns durable projects. Consumers retain only disposable UI projections. */
export interface IProjectService {
	readonly onDidChange: Event<void>;
	list(scope?: ProjectScope): Promise<readonly ProjectSummary[]>;
	read(id: string, scope?: ProjectScope): Promise<Project>;
	create(id: string, name: string, description: string, materials: readonly ProjectMaterial[], scope?: ProjectScope, appearance?: ProjectAppearance): Promise<Project>;
	/** Adds a saved Session using the current project revision. */
	addSession(project: Project, sessionId: string): Promise<Project>;
	/** Changes one project membership. Other memberships of the Session are independent. */
	moveSession(sessionId: string, fromProjectId: string | undefined, toProjectId: string | undefined): Promise<void>;
	/** Organizes an account-scoped provider conversation without creating an Ash Thread. */
	moveExternalConversation(conversationId: string, fromProjectId: string | undefined, toProjectId: string | undefined): Promise<void>;
	update(project: Project, name: string, description: string, materials: readonly ProjectMaterial[]): Promise<Project>;
	/** Returns the saved project and its revision for subsequent edits. */
	setAppearance(project: ProjectSummary, field: 'icon' | 'color', value: string | undefined): Promise<Project>;
	archive(project: ProjectSummary): Promise<Project>;
	restore(project: ProjectSummary): Promise<Project>;
	/** Removes the project and its references, preserving conversations and source files. */
	remove(project: ProjectSummary): Promise<void>;
}

export const IProjectService = createServiceIdentifier<IProjectService>('projectService');
