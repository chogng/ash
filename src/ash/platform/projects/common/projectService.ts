import type { URI } from '../../../base/common/uri.js';
import type { Event } from '../../../base/common/event.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

/** References retain their source location and never authorize reading or modifying it. */
export interface ProjectMaterial {
	readonly resource: URI;
	readonly name: string;
	readonly kind: 'file' | 'folder';
}

export interface ProjectSummary {
	readonly id: string;
	readonly revision: number;
	readonly name: string;
	readonly archived: boolean;
	readonly sessionCount: number;
}

export interface Project extends ProjectSummary {
	readonly description: string;
	readonly materials: readonly ProjectMaterial[];
	readonly sessionIds: readonly string[];
}

/** The backend owns durable projects. Consumers retain only disposable UI projections. */
export interface IProjectService {
	readonly onDidChange: Event<void>;
	list(): Promise<readonly ProjectSummary[]>;
	read(id: string): Promise<Project>;
	create(id: string, name: string, description: string, materials: readonly ProjectMaterial[]): Promise<Project>;
	update(project: Project, name: string, description: string, materials: readonly ProjectMaterial[]): Promise<Project>;
}

export const IProjectService = createServiceIdentifier<IProjectService>('projectService');
