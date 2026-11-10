import type { ProjectDto } from '../../../../../.build/protocol/typescript/index.js';
import type { Event } from '../../../base/common/event.js';
import { combinedDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { localize } from '../../../nls.js';
import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import { AppServerRemoteError } from '../../agentHost/common/appServerError.js';
import type { IProjectService, Project, ProjectAppearance, ProjectMaterial, ProjectScope, ProjectSummary } from '../common/projectService.js';

export class AppServerProjectService implements IProjectService {
	public readonly onDidChange: Event<void>;

	constructor(private readonly connection: AppServerProtocolClient) {
		this.onDidChange = listener => combinedDisposable(
			connection.onNotification(event => { if (event.method === 'project/changed') { listener(); } }),
			connection.onStateChange(state => { if (state === 'ready') { listener(); } }),
		);
	}

	public async list(scope?: ProjectScope): Promise<readonly ProjectSummary[]> {
		try {
			const result = await appServerRequest(this.connection, 'project/list', { scope });
			return result.projects.map(project => ({
				id: project.projectId, revision: project.revision, name: project.name, archived: project.status === 'archived', sessionCount: project.sessionCount,
				createdAtMs: project.createdAtMs, updatedAtMs: project.updatedAtMs,
				icon: project.icon, color: project.color,
			}));
		} catch (error) { throw projectError(error); }
	}

	public async read(id: string, scope?: ProjectScope): Promise<Project> {
		try { return fromDto((await appServerRequest(this.connection, 'project/read', { projectId: id, scope })).project); }
		catch (error) { throw projectError(error); }
	}

	public async create(id: string, name: string, description: string, materials: readonly ProjectMaterial[], scope?: ProjectScope, appearance?: ProjectAppearance): Promise<Project> {
		try {
			return fromDto((await appServerRequest(this.connection, 'project/create', {
				commandId: id, projectId: id, name, description, materials: toMaterials(materials), scope,
				icon: appearance?.icon, color: appearance?.color,
			})).project);
		} catch (error) { throw projectError(error); }
	}

	public async addSession(project: Project, sessionId: string): Promise<Project> {
		try {
			return fromDto((await appServerRequest(this.connection, 'project/session/link', {
				commandId: generateUuid(), projectId: project.id, expectedRevision: project.revision, sessionId,
			})).project);
		} catch (error) { throw projectError(error); }
	}

	public async moveSession(sessionId: string, fromProjectId: string | undefined, toProjectId: string | undefined): Promise<void> {
		if (fromProjectId === toProjectId) return;
		// Link first so a failed transfer preserves the existing membership.
		// Retrying can skip a link that already succeeded.
		if (toProjectId) {
			const destination = await this.read(toProjectId);
			if (!destination.sessionIds.includes(sessionId)) await this.addSession(destination, sessionId);
		}
		if (!fromProjectId) return;
		const source = await this.read(fromProjectId);
		if (!source.sessionIds.includes(sessionId)) return;
		try {
			await appServerRequest(this.connection, 'project/session/unlink', {
				commandId: generateUuid(), projectId: source.id, expectedRevision: source.revision, sessionId,
			});
		} catch (error) { throw projectError(error); }
	}

	public async moveExternalConversation(conversationId: string, fromProjectId: string | undefined, toProjectId: string | undefined): Promise<void> {
		if (fromProjectId === toProjectId) return;
		try {
			if (toProjectId) {
				const destination = await this.read(toProjectId, 'chat');
				if (!destination.externalConversationIds?.includes(conversationId)) {
					await appServerRequest(this.connection, 'project/conversation/membership', {
						commandId: generateUuid(), projectId: destination.id, expectedRevision: destination.revision, conversationId, membership: 'link',
					});
				}
			}
			if (fromProjectId) {
				const source = await this.read(fromProjectId, 'chat');
				if (source.externalConversationIds?.includes(conversationId)) {
					await appServerRequest(this.connection, 'project/conversation/membership', {
						commandId: generateUuid(), projectId: source.id, expectedRevision: source.revision, conversationId, membership: 'unlink',
					});
				}
			}
		} catch (error) { throw projectError(error); }
	}

	public async update(project: Project, name: string, description: string, materials: readonly ProjectMaterial[]): Promise<Project> {
		try {
			return fromDto((await appServerRequest(this.connection, 'project/details/update', { commandId: generateUuid(), projectId: project.id, expectedRevision: project.revision, name, description, materials: toMaterials(materials) })).project);
		} catch (error) { throw projectError(error); }
	}

	public async archive(project: ProjectSummary): Promise<Project> {
		try {
			return fromDto((await appServerRequest(this.connection, 'project/archive', { commandId: generateUuid(), projectId: project.id, expectedRevision: project.revision })).project);
		} catch (error) { throw projectError(error); }
	}

	public async setAppearance(project: ProjectSummary, field: 'icon' | 'color', value: string | undefined): Promise<void> {
		try {
			await appServerRequest(this.connection, 'project/appearance/update', {
				commandId: generateUuid(), projectId: project.id, expectedRevision: project.revision, field, value: value ?? null,
			});
		} catch (error) { throw projectError(error); }
	}

	public async restore(project: ProjectSummary): Promise<Project> {
		try {
			return fromDto((await appServerRequest(this.connection, 'project/restore', { commandId: generateUuid(), projectId: project.id, expectedRevision: project.revision })).project);
		} catch (error) { throw projectError(error); }
	}

	public async remove(project: ProjectSummary): Promise<void> {
		try {
			await appServerRequest(this.connection, 'project/delete', { commandId: generateUuid(), projectId: project.id, expectedRevision: project.revision });
		} catch (error) { throw projectError(error); }
	}

}

function fromDto(project: ProjectDto): Project {
	return {
		id: project.projectId, revision: project.revision, name: project.name, archived: project.status === 'archived',
		createdAtMs: project.createdAtMs, updatedAtMs: project.updatedAtMs,
		icon: project.icon, color: project.color,
		description: project.description, sessionIds: project.sessionIds, externalConversationIds: project.externalConversationIds,
		sessionCount: project.sessionIds.length + (project.externalConversationIds?.length ?? 0),
		roots: project.roots.map(root => URI.parse(root.path)),
		materials: project.materials.map(material => material.kind === 'text'
			? { kind: 'text', id: material.id, name: material.name, content: material.content }
			: { name: material.name, kind: material.kind, resource: URI.parse(material.path) }),
	};
}

function toMaterials(materials: readonly ProjectMaterial[]) {
	return materials.map(material => material.kind === 'text'
		? { kind: 'text' as const, id: material.id, name: material.name, content: material.content }
		: { name: material.name, kind: material.kind, path: material.resource.toString() });
}

function projectError(error: unknown): Error {
	if (error instanceof AppServerRemoteError && error.errorName === 'ProjectRevisionConflict') {
		return new Error(localize('projects.conflict', 'This project changed in another window. Refresh and try again.'), { cause: error });
	}
	return new Error(localize('projects.requestFailed', 'Could not access projects. Check the connection and try again.'), { cause: error });
}
