import { Separator, SubmenuAction, type IAction } from '../../../../../base/common/actions.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize } from '../../../../../nls.js';
import type { IProjectService } from '../../../../../platform/projects/common/projectService.js';
import type { ISessionsListModelService, SessionSortDirection, SessionSortMode, SessionsListMode } from '../../../../services/sessions/browser/sessionsListModelService.js';
import type { CatalogProjectCreator } from './sessionsCatalogList.js';

export function getSessionsListGroupingHelp(): string {
	return localize('sessions.list.groupingHelp', 'Use Tab to reach More Sessions Actions beside Projects or Recents and press Enter. Under Group By, choose Projects to browse conversations by project or Flat List to browse recent conversations together. Chat and Code remember their choices separately. Sort By changes the order of conversations.');
}

export function getSessionsListAttentionHelp(): string {
	return localize('sessions.list.attentionHelp', 'In More Sessions Actions, choose Show, then Needs Attention to group background sessions waiting for input or with failing checks. Press Enter on a row to open the conversation that needs attention.');
}

export interface SessionListProjectOrganization {
	readonly current?: string;
	readonly destinations: readonly { readonly id: string; readonly title: string; }[];
	readonly creator?: CatalogProjectCreator;
	move(projectId: string | undefined): Promise<void>;
}

export interface SessionListOrganization {
	readonly pinned?: boolean;
	readonly setPinned?: (pinned: boolean) => void | Promise<void>;
	readonly moveToGroup?: (id: string | null) => Promise<void>;
	readonly project?: SessionListProjectOrganization;
}

export function sessionProjectOrganization(
	projects: IProjectService,
	sessionId: string,
	current: string | undefined,
	destinations: readonly { readonly id: string; readonly name: string; }[],
): SessionListProjectOrganization {
	return {
		current,
		destinations: destinations.map(({ id, name }) => ({ id, title: name })),
		move: destination => projects.moveSession(sessionId, current, destination),
	};
}

export function sessionListProjectActions(
	mode: SessionsListMode,
	project: SessionListProjectOrganization,
	run: (operation: () => Promise<void>) => Promise<void>,
	createProject?: () => void,
): readonly IAction[] {
	const projectIcon = mode === 'code' ? Lxicon.folder : Lxicon.projects;
	const targets = project.destinations.filter(({ id }) => id !== project.current).map(({ id, title }): IAction => ({
		id: `sessions.list.moveToProject.${id}`, label: title, tooltip: title,
		icon: projectIcon, enabled: true, run: () => run(() => project.move(id)),
	}));
	const newProject = localize('sessions.list.newProject', 'New project');
	const create = createProject ? [{
		id: 'sessions.list.createProjectAndMove', label: newProject, tooltip: newProject, icon: Lxicon.add, enabled: true,
		run: createProject,
	}] : [];
	const destinations = Separator.join(create, targets);
	const actions: IAction[] = [];
	if (destinations.length) actions.push(new SubmenuAction('sessions.list.moveToProject', localize('sessions.list.moveToProject', 'Move to project'), destinations, projectIcon));
	if (project.current) actions.push({
		id: 'sessions.list.removeFromProject', label: localize('sessions.list.removeFromProject', 'Remove from project'),
		tooltip: '', enabled: true, run: () => run(() => project.move(undefined)),
	});
	return actions;
}

export function sessionSortActions(model: ISessionsListModelService, mode: SessionsListMode): IAction[] {
	const current = model.getSort(mode);
	const sort = (value: SessionSortMode, label: string): IAction => ({
		id: `sessions.list.sortBy.${value}`, label, tooltip: '', enabled: true,
		checked: current.field === value, run: () => model.setSortMode(mode, value),
	});
	const direction = (value: SessionSortDirection, label: string): IAction => ({
		id: `sessions.list.sortDirection.${value}`, label, tooltip: '', enabled: true,
		checked: current.direction === value, run: () => model.setSortDirection(mode, value),
	});
	return [
		sort('name', localize('sessions.list.sortName', 'Name')),
		sort('updated', localize('sessions.list.sortUpdated', 'Last Updated')),
		sort('created', localize('sessions.list.sortCreated', 'Date Created')),
		new Separator(),
		direction('ascending', localize('sessions.list.sortAscending', 'Ascending')),
		direction('descending', localize('sessions.list.sortDescending', 'Descending')),
	];
}
