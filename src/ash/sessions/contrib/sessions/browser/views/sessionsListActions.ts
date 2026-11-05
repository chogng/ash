import { Separator, SubmenuAction, type IAction } from '../../../../../base/common/actions.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize } from '../../../../../nls.js';
import type { IProjectService } from '../../../../../platform/projects/common/projectService.js';
import type { ISessionsListModelService, SessionSortDirection, SessionSortMode } from '../../../../services/sessions/browser/sessionsListModelService.js';

export interface SessionListProjectOrganization {
	readonly current?: string;
	readonly destinations: readonly { readonly id: string; readonly title: string; }[];
	readonly loadDestinations?: (signal: AbortSignal) => Promise<SessionListProjectOrganization['destinations']>;
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
	project: SessionListProjectOrganization,
	destinations: SessionListProjectOrganization['destinations'],
	run: (operation: () => Promise<void>) => Promise<void>,
): readonly IAction[] {
	const targets = destinations.map(({ id, title }): IAction => ({
		id: `sessions.list.moveToProject.${id}`, label: title, tooltip: title,
		checked: id === project.current, enabled: id !== project.current, run: () => run(() => project.move(id)),
	}));
	const move = new SubmenuAction('sessions.list.moveToProject', localize('sessions.chatgpt.moveToProject', 'Move to project'),
		targets.length ? targets : [{ id: 'sessions.list.noProjectDestination', label: localize('sessions.chatgpt.noProjects', 'No projects'), tooltip: '', enabled: false, run: () => { } }], Lxicon.folder);
	return project.current ? [move, {
		id: 'sessions.list.removeFromProject', label: localize('sessions.list.removeFromProject', 'Remove from project'),
		tooltip: '', enabled: true, run: () => run(() => project.move(undefined)),
	}] : [move];
}

export function sessionSortActions(model: ISessionsListModelService): IAction[] {
	const sort = (value: SessionSortMode, label: string): IAction => ({
		id: `sessions.list.sortBy.${value}`, label, tooltip: '', enabled: true,
		checked: model.sortMode === value, run: () => model.setSortMode(value),
	});
	const direction = (value: SessionSortDirection, label: string): IAction => ({
		id: `sessions.list.sortDirection.${value}`, label, tooltip: '', enabled: true,
		checked: model.sortDirection === value, run: () => model.setSortDirection(value),
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
