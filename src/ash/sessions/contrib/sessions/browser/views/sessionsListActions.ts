import { getActiveElement } from '../../../../../base/browser/dom.js';
import { Separator, SubmenuAction, type IAction } from '../../../../../base/common/actions.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import type { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize } from '../../../../../nls.js';
import { getFlatContextMenuActions } from '../../../../../platform/actions/browser/menuEntryActionViewItem.js';
import type { IMenuService } from '../../../../../platform/actions/common/actions.js';
import type { ICommandService } from '../../../../../platform/commands/common/commands.js';
import type { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import type { INotificationService } from '../../../../../platform/notification/common/notification.js';
import type { IProjectService } from '../../../../../platform/projects/common/projectService.js';
import { Menus } from '../../../../browser/menus.js';
import { renderInlineRenameInput, showInlineRenameInput } from '../../../../browser/parts/titlebar/inlineRenameInput.js';
import { SessionsMenuActiveConversationContext, SessionsMenuConversationPinnedContext } from '../../../../common/contextkeys.js';
import type { ISessionsListModelService, SessionSortDirection, SessionSortMode, SessionsListMode } from '../../../../services/sessions/browser/sessionsListModelService.js';
import type { CatalogProjectCreator, SessionsCatalogRow } from './sessionsCatalogList.js';

export type ConversationMenuTarget = { readonly sessionId: string; readonly threadId?: string; } | { readonly catalogId: string; } | { readonly untitledSessionId: string; };

export function conversationMenuActions(
	mode: SessionsListMode, menus: IMenuService, commands: ICommandService, context: IContextKeyService | undefined,
	target: ConversationMenuTarget | undefined, pinned: boolean, actions: IAction[],
): IAction[] {
	if (context && target && 'sessionId' in target) {
		SessionsMenuActiveConversationContext.bindTo(context).set(true);
		SessionsMenuConversationPinnedContext.bindTo(context).set(pinned);
	}
	const menu = mode === 'code' ? Menus.SidebarCodeSessionContext : Menus.SidebarChatSessionContext;
	const contributed = getFlatContextMenuActions(menus.getMenuActions(menu, { arg: target }, context));
	return Separator.join(actions, contributed).map(action => {
		if (action.id === 'agentSession.addToProject') return { ...action, run: () => commands.executeCommand(action.id, target, mode) };
		if (action.id === 'agentSession.delete') return { ...action, class: 'ash-session-delete-action', run: () => action.run() };
		return action;
	});
}

export async function catalogConversationActions(
	row: Pick<SessionsCatalogRow, 'sessionId' | 'rename' | 'getActions'>, signal: AbortSignal,
	rename: (run: NonNullable<SessionsCatalogRow['rename']>) => void, projectActions: () => readonly IAction[],
): Promise<IAction[]> {
	let actions = [...await row.getActions(signal)];
	if (signal.aborted) return [];
	const renameConversation = row.rename;
	if (!row.sessionId && renameConversation) {
		actions = Separator.join([{
			id: 'sessions.list.renameConversation',
			label: localize('sessions.list.rename', 'Rename'),
			tooltip: '', enabled: true, icon: Lxicon.edit, run: () => rename(renameConversation),
		}], actions);
	}
	const separator = actions.map(action => action instanceof Separator).lastIndexOf(true);
	actions.splice(separator < 0 ? actions.length : separator, 0, ...projectActions());
	return actions;
}

export function startConversationRename(row: HTMLElement, store: DisposableStore, notifications: INotificationService, options: {
	readonly name: string;
	readonly rename: (title: string) => Promise<void>;
	readonly validate?: (title: string) => string | undefined;
	readonly finish: (restoreFocus: boolean) => void;
}): HTMLInputElement {
	const { name, rename, finish, validate = (title: string): string | undefined => title && Array.from(title).length <= 256
		? undefined : localize('sessions.titlebar.invalidName', 'Enter a name with 1 to 256 characters.') } = options;
	let saving = false;
	const save = async (): Promise<void> => {
		if (saving) return;
		const title = input.value.trim();
		const error = validate(title);
		if (error) {
			input.setCustomValidity(error);
			input.setAttribute('aria-invalid', 'true');
			input.reportValidity();
			return;
		}
		if (title === name) {
			finish(true);
			return;
		}
		saving = input.readOnly = true;
		try {
			await rename(title);
			finish(getActiveElement(input.ownerDocument) === input);
		} catch (error) {
			if (!store.isDisposed) {
				saving = input.readOnly = false;
				notifications.error(toErrorMessage(error));
				if (getActiveElement(input.ownerDocument) !== input) finish(false);
			}
		}
	};
	const input = renderInlineRenameInput(row, {
		label: localize('sessions.titlebar.sessionName', 'Session name'),
		onAccept: () => { void save(); },
		onCancel: () => { if (!saving) finish(true); },
		onBlur: () => { if (!saving) finish(false); },
	}, store);
	showInlineRenameInput(input, name);
	return input;
}

export function getSessionsListGroupingHelp(): string {
	return localize('sessions.list.groupingHelp', 'Use Tab to reach More Sessions Actions beside Projects or Recents and press Enter. Under Group By, choose Projects to browse conversations by project or Flat List to browse recent conversations together. Chat and Code remember their choices separately. Sort By changes the order of conversations. Under Show, Include Task Run Conversations lists task runs while respecting conversations you hid individually.');
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
