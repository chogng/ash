import { basename, extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { createUuid } from '../../../../base/common/uuid.js';
import type { IProjectService, Project } from '../../../../platform/projects/common/projectService.js';
import { sessionWorkspaceUri } from '../../../common/sessionWorkspace.js';
import type { ISession } from '../../../services/sessions/common/session.js';

export async function readCodeProjects(projects: IProjectService): Promise<readonly Project[]> {
	const summaries = await projects.list('code');
	return Promise.all(summaries.map(project => projects.read(project.id, 'code')));
}

export function workspaceFolderKey(resource: URI): string {
	const path = resource.toEncodedComponents().path.replace(/\/+$/u, '') || '/';
	return extUriBiasedIgnorePathCase.getComparisonKey(resource.withEncodedPath(path));
}

export function unassignedCodeFolder(session: ISession, organized: ReadonlySet<string>): URI | undefined {
	if (session.kind !== 'code' || session.status !== 'active' || session.backendSessionId
		|| !session.workspace || organized.has(session.sessionId)) return undefined;
	const resource = sessionWorkspaceUri(session.workspace);
	return resource.scheme === 'file' && !resource.authority ? resource : undefined;
}

export function projectFolders(project: Project): URI[] {
	const folders = [...project.roots ?? [], ...project.materials.filter(material => material.kind === 'folder').map(material => material.resource)];
	return [...new Map(folders.filter(folder => folder.scheme === 'file' && !folder.authority)
		.map(folder => [extUriBiasedIgnorePathCase.getComparisonKey(folder), folder])).values()];
}

export async function projectForFolder(service: IProjectService, projects: readonly Project[], resource: URI): Promise<Project> {
	const matching = projects.find(project => !project.archived
		&& projectFolders(project).some(folder => extUriBiasedIgnorePathCase.isEqual(folder, resource)));
	if (matching) return matching;
	// A folder opened in two windows at once uses the same Project creation command.
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(extUriBiasedIgnorePathCase.getComparisonKey(resource)));
	const id = `folder-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
	const name = basename(resource) || resource.fsPath;
	return service.create(projects.some(project => project.id === id) ? createUuid() : id, name, '', [{ kind: 'folder', resource, name }], 'code');
}
