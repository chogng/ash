import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { createUuid } from '../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProjectService, type Project } from '../../../../platform/projects/common/projectService.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { ISessionGroupsService } from '../../../services/sessions/browser/sessionGroupsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { projectForFolder, projectFolders, readCodeProjects, unassignedCodeFolder, workspaceFolderKey } from '../../chat/browser/sessionWorkspaceProjects.js';

registerAction2(class RepairArchivedProjects extends Action2 {
	constructor() {
		super({
			id: 'projects.repairArchived',
			title: localize2('projects.repairArchived', 'Archive Conversations in Archived Projects…'),
			category: localize2('projects.title', 'Projects'),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const projects = accessor.get(IProjectService);
		const sessions = accessor.get(ISessionsManagementService);
		const input = accessor.get(IQuickInputService);
		const notifications = accessor.get(INotificationService);
		const load = async () => {
			await sessions.refresh();
			const archived = (await projects.list()).filter(project => project.archived && project.sessionCount > 0);
			const details = await Promise.all(archived.map(project => projects.read(project.id)));
			const membership = new Map<string, Project[]>();
			for (const project of details.filter(project => project.archived).sort((a, b) => a.id.localeCompare(b.id))) {
				for (const id of project.sessionIds) {
					const members = membership.get(id);
					if (members) members.push(project);
					else membership.set(id, [project]);
				}
			}
			return activePrimarySessions(sessions).flatMap(session => {
				const owners = membership.get(session.sessionId);
				return owners ? [{
					id: JSON.stringify([session.sessionId, ...owners.map(project => project.id)]),
					label: session.title, description: owners.map(project => project.name).join(', '), sessionId: session.sessionId,
				}] : [];
			});
		};
		const selected = await reviewRepairs(input, notifications, load, localize('projects.repairArchivePick', 'Select conversations to archive'));
		for (const item of selected) await sessions.archiveSession(item.sessionId);
	}
});

registerAction2(class RepairCodeFolderProjects extends Action2 {
	constructor() {
		super({
			id: 'projects.repairCodeFolders',
			title: localize2('projects.repairCodeFolders', 'Link Unassigned Code Conversations to Folder Projects…'),
			category: localize2('projects.title', 'Projects'),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const projects = accessor.get(IProjectService);
		const sessions = accessor.get(ISessionsManagementService);
		const groups = accessor.get(ISessionGroupsService);
		const input = accessor.get(IQuickInputService);
		const notifications = accessor.get(INotificationService);
		const load = async () => {
			await sessions.refresh();
			const existing = await readCodeProjects(projects);
			const organized = new Set([...existing.flatMap(project => project.sessionIds), ...groups.groups.flatMap(group => group.sessionIds)]);
			const byFolder = new Map<string, Project[]>();
			for (const project of existing) {
				for (const folder of projectFolders(project)) {
					const key = workspaceFolderKey(folder);
					const matching = byFolder.get(key);
					if (matching) matching.push(project);
					else byFolder.set(key, [project]);
				}
			}
			return activePrimarySessions(sessions).flatMap(session => {
				const resource = unassignedCodeFolder(session, organized);
				if (!resource) return [];
				const key = workspaceFolderKey(resource);
				const matching = byFolder.get(key);
				const target = matching?.find(project => !project.archived);
				if (matching && !target) return [];
				return [{
					id: JSON.stringify([session.sessionId, key, target?.id]),
					label: session.title,
					description: target?.name ?? localize('projects.repairNewFolderProject', 'New project in this folder'),
					detail: resource.fsPath, key, resource, target, sessionId: session.sessionId,
				}];
			});
		};
		const selected = await reviewRepairs(input, notifications, load, localize('projects.repairFolderPick', 'Select Code conversations to link'));
		const updated = new Map<string, Project>();
		for (const { key, resource, target, sessionId } of selected) {
			const project = updated.get(target?.id ?? key) ?? target ?? await createRepairFolderProject(projects, resource);
			updated.set(target?.id ?? key, project.sessionIds.includes(sessionId) ? project : await projects.addSession(project, sessionId));
		}
	}
});

async function createRepairFolderProject(projects: IProjectService, resource: URI): Promise<Project> {
	const key = workspaceFolderKey(resource);
	const existing = await readCodeProjects(projects);
	if (existing.some(project => projectFolders(project).some(folder => workspaceFolderKey(folder) === key))) throw repairCandidatesChanged();
	// Use the same creation identity as migration so concurrent repairs share a new project.
	const created = await projectForFolder(projects, existing, resource);
	if ((await projects.list('code')).some(project => project.id === created.id)) {
		const current = await projects.read(created.id, 'code');
		if (!current.archived && projectFolders(current).some(folder => workspaceFolderKey(folder) === key)) return current;
		throw repairCandidatesChanged();
	}
	// A create receipt can outlive a deleted project. The selected repair explicitly allows a new one.
	const name = basename(resource) || resource.fsPath;
	return projects.create(createUuid(), name, '', [{ kind: 'folder', resource, name }], 'code');
}

function activePrimarySessions(sessions: ISessionsManagementService) {
	if (sessions.state !== 'ready' || !sessions.primaryCatalogReady) {
		throw new Error(localize('projects.repairCatalogUnavailable', 'Could not load all local conversations. Try again when the host is available.'));
	}
	return sessions.sessions.filter(session => !session.backendSessionId && session.status === 'active');
}

async function reviewRepairs<T extends IQuickPickItem & { id: string; }>(
	input: IQuickInputService, notifications: INotificationService, load: () => Promise<readonly T[]>, title: string,
): Promise<readonly T[]> {
	const candidates = await load();
	if (!candidates.length) {
		notifications.info(localize('projects.repairNoCandidates', 'No conversations are available for this repair.'));
		return [];
	}
	using resources = new DisposableStore();
	const picker = resources.add(input.createQuickPick<T>());
	picker.ariaLabel = picker.title = title;
	picker.placeholder = localize('projects.repairPickInstructions', 'Use Space to select conversations and Enter to apply the selected changes.');
	picker.canSelectMany = true;
	picker.items = candidates;
	const picked = await new Promise<readonly T[]>(resolve => {
		resources.add(picker.onDidAccept(() => { resolve([...picker.selectedItems]); picker.hide(); }));
		resources.add(picker.onDidHide(() => resolve([])));
		picker.show();
	});
	if (!picked.length) return [];
	const current = new Map((await load()).map(item => [item.id, item]));
	return picked.map(item => {
		const latest = current.get(item.id);
		if (!latest) throw repairCandidatesChanged();
		return latest;
	});
}

function repairCandidatesChanged(): Error {
	return new Error(localize('projects.repairCandidatesChanged', 'The selected conversations or projects changed. Run the repair command again to review them.'));
}
