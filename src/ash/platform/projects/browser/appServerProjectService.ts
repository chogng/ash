import type { ProjectDto } from '../../../../../.build/protocol/typescript/index.js';
import type { Event } from '../../../base/common/event.js';
import { combinedDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { localize } from '../../../nls.js';
import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import { AppServerRemoteError } from '../../agentHost/common/appServerError.js';
import type { IProjectService, Project, ProjectMaterial, ProjectSummary } from '../common/projectService.js';

export class AppServerProjectService implements IProjectService {
	public readonly onDidChange: Event<void>;

	constructor(private readonly connection: AppServerProtocolClient) {
		this.onDidChange = listener =>
			combinedDisposable(
				connection.onNotification(event => {
					if (event.method === 'project/changed') {
						listener();
					}
				}),
				connection.onStateChange(state => {
					if (state === 'ready') {
						listener();
					}
				}),
			);
	}

	public async list(): Promise<readonly ProjectSummary[]> {
		try {
			const result = await appServerRequest(this.connection, 'project/list', {});
			return result.projects.map(project => ({
				id: project.projectId,
				revision: project.revision,
				name: project.name,
				archived: project.status === 'archived',
				sessionCount: project.sessionCount,
				createdAtMs: project.createdAtMs ?? undefined,
				updatedAtMs: project.updatedAtMs ?? undefined,
			}));
		} catch (error) {
			throw projectError(error);
		}
	}

	public async read(id: string): Promise<Project> {
		try {
			return fromDto((await appServerRequest(this.connection, 'project/read', { projectId: id })).project);
		} catch (error) {
			throw projectError(error);
		}
	}

	public async create(id: string, name: string, description: string, materials: readonly ProjectMaterial[]): Promise<Project> {
		try {
			return fromDto(
				(
					await appServerRequest(this.connection, 'project/create', {
						commandId: id,
						projectId: id,
						name,
						description,
						materials: toMaterials(materials),
					})
				).project,
			);
		} catch (error) {
			throw projectError(error);
		}
	}

	public async addSession(project: Project, sessionId: string): Promise<Project> {
		try {
			return fromDto(
				(
					await appServerRequest(this.connection, 'project/session/link', {
						commandId: generateUuid(),
						projectId: project.id,
						expectedRevision: project.revision,
						sessionId,
					})
				).project,
			);
		} catch (error) {
			throw projectError(error);
		}
	}

	public async update(project: Project, name: string, description: string, materials: readonly ProjectMaterial[]): Promise<Project> {
		try {
			return fromDto(
				(
					await appServerRequest(this.connection, 'project/details/update', {
						commandId: generateUuid(),
						projectId: project.id,
						expectedRevision: project.revision,
						name,
						description,
						materials: toMaterials(materials),
					})
				).project,
			);
		} catch (error) {
			throw projectError(error);
		}
	}

	public async archive(project: ProjectSummary): Promise<Project> {
		try {
			return fromDto(
				(
					await appServerRequest(this.connection, 'project/archive', {
						commandId: generateUuid(),
						projectId: project.id,
						expectedRevision: project.revision,
					})
				).project,
			);
		} catch (error) {
			throw projectError(error);
		}
	}

	public async remove(project: ProjectSummary): Promise<void> {
		try {
			await appServerRequest(this.connection, 'project/delete', {
				commandId: generateUuid(),
				projectId: project.id,
				expectedRevision: project.revision,
			});
		} catch (error) {
			throw projectError(error);
		}
	}
}

function fromDto(project: ProjectDto): Project {
	return {
		id: project.projectId,
		revision: project.revision,
		name: project.name,
		archived: project.status === 'archived',
		createdAtMs: project.createdAtMs ?? undefined,
		updatedAtMs: project.updatedAtMs ?? undefined,
		description: project.description,
		sessionIds: project.sessionIds,
		sessionCount: project.sessionIds.length,
		materials: project.materials.map(material => ({
			name: material.name,
			kind: material.kind,
			resource: URI.parse(material.path),
		})),
	};
}

function toMaterials(materials: readonly ProjectMaterial[]) {
	return materials.map(material => ({
		name: material.name,
		kind: material.kind,
		path: material.resource.toString(),
	}));
}

function projectError(error: unknown): Error {
	if (error instanceof AppServerRemoteError && error.errorName === 'ProjectRevisionConflict') {
		return new Error(localize('projects.conflict', 'This project changed in another window. Refresh and try again.'), { cause: error });
	}
	return new Error(localize('projects.requestFailed', 'Could not access projects. Check the connection and try again.'), { cause: error });
}
