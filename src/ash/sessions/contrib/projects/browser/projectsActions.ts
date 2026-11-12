import type { IAction } from '../../../../base/common/actions.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProjectService, type ProjectSummary } from '../../../../platform/projects/common/projectService.js';
import { groupChatList, IChatListCatalog, type ChatListGroup } from '../../chat/browser/chatListModel.js';
import type { ConversationProjectEditor, SessionsCatalogProjectOperations } from '../../sessions/browser/views/sessionsCatalogList.js';
import { readCatalogProjectEdit, type ChatProjectEdit } from './projectDialogService.js';
import { IProjectsService, type ProjectSortOrder } from './projectsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { type MenuId, MenusRegistry } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import type { IContextMenuMenuDelegate, IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { Menus } from '../../../browser/menus.js';

export const ARCHIVE_PROJECT_COMMAND = 'projects.archive';

const sidebarProjectActions = [
	{ key: 'pin', group: '1_edit', order: 0, icon: Lxicon.pin, title: localize('sessions.list.pinProject', 'Pin') },
	{ key: 'unpin', group: '1_edit', order: 0, icon: Lxicon.pinFilled, title: localize('sessions.list.unpinProject', 'Unpin') },
	{ key: 'edit', group: '2_appearance', order: 1, icon: Lxicon.gear, title: localize({ bundle: 'ash.menu', key: 'edit' }, 'Edit') },
	{ key: 'archive', group: '3_remove', order: 1, icon: Lxicon.archive, title: localize('projects.archive', 'Archive') },
	{ key: 'remove', group: '3_remove', order: 2, icon: Lxicon.trash, title: localize('projects.delete', 'Delete'), destructive: true },
] as const;

type SidebarProjectAction = typeof sidebarProjectActions[number]['key'];

interface SidebarProjectMenuTarget {
	readonly projectId: string;
	readonly actions: Partial<Record<SidebarProjectAction, () => void | Promise<void>>>;
}

CommandsRegistry.registerMany(sidebarProjectActions.map(({ key }) => ({
	id: `sessions.sidebarProject.${key}`,
	handler: (_accessor, target) => {
		const run = (target as SidebarProjectMenuTarget | undefined)?.actions?.[key];
		if (typeof run === 'function') return run();
	},
})));

function registerSidebarProjectActions(menuId: MenuId, editTitle: string): void {
	MenusRegistry.appendMenuItems(sidebarProjectActions.map(({ key, group, order, title, ...appearance }) => ({
		id: menuId,
		item: { command: { id: `sessions.sidebarProject.${key}`, title: key === 'edit' ? editTitle : title, ...appearance }, group, order, when: ContextKeyExpr.has(`sidebarProject.${key}`) },
	})));
}

registerSidebarProjectActions(Menus.SidebarChatProjectContext, localize('projects.edit', 'Edit details'));
registerSidebarProjectActions(Menus.SidebarCodeProjectContext, localize({ bundle: 'ash.menu', key: 'edit' }, 'Edit'));

export function showSidebarProjectMenu(contextMenus: IContextMenuService, context: IContextKeyService,
	mode: 'chat' | 'code', target: SidebarProjectMenuTarget, presentation: Pick<IContextMenuMenuDelegate, 'getAnchor' | 'onHide'>): void {
	context.bufferChangeEvents(() => {
		for (const { key } of sidebarProjectActions) context.setContext(`sidebarProject.${key}`, !!target.actions[key]);
	});
	contextMenus.showContextMenu({
		menuId: mode === 'code' ? Menus.SidebarCodeProjectContext : Menus.SidebarChatProjectContext,
		contextKeyService: context,
		menuActionOptions: { arg: target },
		...presentation,
		autoSelectFirstItem: true,
	});
}

CommandsRegistry.register(ARCHIVE_PROJECT_COMMAND, async (accessor, id: unknown, scope: unknown): Promise<boolean> => {
	if (typeof id !== 'string' || !id || scope !== 'chat' && scope !== 'code' && scope !== 'catalog') {
		throw new TypeError(localize({ bundle: 'ash', key: 'projects.invalidId' }, 'Choose a valid project.'));
	}
	const dialogs = accessor.get(IDialogService);
	if (scope === 'catalog') {
		const catalog = accessor.get(IChatListCatalog);
		const project = groupChatList(catalog.sources.map(source => source.snapshot.get()), 'projects').find(group => group.key === id)?.project;
		if (!project?.archive || !await confirmProjectArchive(dialogs, project.title)) return false;
		return finishProjectArchive(project.title, project.archive);
	}
	const projects = accessor.get(IProjectService);
	const view = scope === 'chat' ? accessor.get(IProjectsService) : undefined;
	const catalog = scope === 'chat' ? accessor.get(IChatListCatalog) : undefined;
	const sessions = accessor.get(ISessionsManagementService);
	const project = await projects.read(id, scope);
	if (project.archived || !await confirmProjectArchive(dialogs, project.name)) return false;
	return finishProjectArchive(project.name, async () => {
		const current = await projects.read(id, scope);
		if (current.archived) return true;
		if (current.sessionIds.length) {
			await sessions.refresh();
			// Membership can change while the catalog is loading.
			const latest = await projects.read(id, scope);
			if (latest.archived) return true;
			if (latest.revision !== current.revision) return false;
			if (sessions.state !== 'ready' || !sessions.primaryCatalogReady) return false;
			// Durable Project membership uses the primary host's raw Session IDs.
			const members = new Set(current.sessionIds);
			for (const session of sessions.sessions) {
				if (!session.backendSessionId && session.status === 'active' && members.has(session.sessionId)) {
					await sessions.archiveSession(session.sessionId);
				}
			}
		}
		const external = new Set(current.externalConversationIds);
		if (external.size) {
			const latest = await projects.read(id, scope);
			if (latest.archived) return true;
			if (latest.revision !== current.revision) return false;
			let failure: unknown;
			for (const source of catalog?.sources ?? []) {
				if (!source.archiveProjectMembers) continue;
				try {
					const archived = await source.archiveProjectMembers(external);
					for (const reference of archived) external.delete(reference);
				} catch (error) {
					failure ??= error;
				}
				if (!external.size) break;
			}
			if (external.size) {
				if (failure) throw failure;
				return false;
			}
		}
		if (view) return view.archive(current);
		await projects.archive(current);
		return true;
	});
});

async function confirmProjectArchive(dialogs: IDialogService, title: string): Promise<boolean> {
	const result = await dialogs.confirm({
		message: localize('projects.archiveConfirm', 'Archive project "{0}" and its conversations?', title),
		detail: localize('projects.archiveDetail', 'This archives every active conversation in the project. Restoring the project leaves those conversations archived.'),
		primaryButton: localize('projects.archive', 'Archive'),
	});
	return result.confirmed;
}

async function finishProjectArchive(title: string, archive: () => Promise<boolean>): Promise<boolean> {
	try {
		if (await archive()) return true;
	} catch (error) {
		throw new Error(localize('projects.archiveIncomplete', 'Could not finish archiving "{0}". Try again to continue.', title), { cause: error });
	}
	throw new Error(localize('projects.archiveIncomplete', 'Could not finish archiving "{0}". Try again to continue.', title));
}

interface ProjectsActionOptions {
	readonly showDialog: (edit?: ChatProjectEdit) => void;
	readonly focusList: () => void;
	readonly isVisible: () => boolean;
}

/** Routes catalog actions to the local project service or the conversation project's provider. */
export class ProjectsActions extends Disposable {
	private readonly readConversationProject = this._register(new MutableDisposable());

	constructor(
		private readonly options: ProjectsActionOptions,
		@IProjectsService private readonly projects: IProjectsService,
		@IDialogService private readonly dialogs: IDialogService,
		@INotificationService private readonly notifications: INotificationService,
		@ICommandService private readonly commands: ICommandService,
	) {
		super();
	}

	cancelPendingEdit(): void {
		this.readConversationProject.clear();
	}

	createProject(): void {
		this.options.showDialog();
	}

	getPinAction(id: string): IAction {
		const pinned = this.projects.isPinned(id);
		const pinLabel = pinned ? localize('projects.unpin', 'Unpin') : localize('projects.pin', 'Pin');
		return {
			id: 'projects.pin',
			label: pinLabel,
			tooltip: pinLabel,
			icon: pinned ? Lxicon.pinFilled : Lxicon.pinned,
			enabled: !this.projects.state.get().busy,
			checked: pinned,
			run: () => this.projects.togglePinned(id),
		};
	}

	getConversationProjectActions(project: ChatListGroup): readonly IAction[] {
		const editor = project.project?.editDetails;
		const key = project.project?.preferenceKey;
		const editLabel = localize('projects.edit', 'Edit details');
		const editActions: IAction[] = editor || key ? [{
			id: 'projects.edit',
			label: editLabel,
			tooltip: editLabel,
			icon: Lxicon.edit,
			enabled: true,
			run: () => {
				const appearance = key ? this.projects.getCatalogProjectAppearance(key) : undefined;
				return this.loadProjectEdit(signal => readCatalogProjectEdit(project.title, appearance, editor, signal));
			},
		}] : [];
		const archive = project.project?.archive && (() => this.commands.executeCommand<boolean>(ARCHIVE_PROJECT_COMMAND, project.key, 'catalog'));
		const remove = project.project?.remove;
		return [...editActions, ...getProjectRemovalActions(this.dialogs, project.title, { archive, remove }, operation => this.runRemoval(operation), !this.projects.state.get().busy)];
	}

	restoreProject(restore: () => void | Promise<void | boolean>): void {
		void Promise.resolve().then(restore).catch(error => this.notifications.error(toErrorMessage(error)));
	}

	getSortActions(): readonly IAction[] {
		const selected = this.projects.state.get().sortOrder;
		const options: readonly { order: ProjectSortOrder; label: string; }[] = [
			{ order: 'updated', label: localize('projects.sortUpdated', 'Last updated') },
			{ order: 'created', label: localize('projects.sortCreated', 'Date created') },
			{ order: 'name', label: localize('projects.sortName', 'Alphabetical') },
		];
		return options.map(({ order, label }) => ({
			id: `projects.sort.${order}`,
			label,
			tooltip: label,
			enabled: true,
			checked: selected === order,
			run: () => {
				this.projects.setSortOrder(order);
			},
		}));
	}

	getProjectActions(project: ProjectSummary): readonly IAction[] {
		const action = (id: string, label: string, icon: IAction['icon'], run: () => unknown): IAction => ({
			id,
			label,
			tooltip: label,
			icon,
			enabled: !this.projects.state.get().busy,
			run,
		});
		return [
			action('projects.edit', localize('projects.edit', 'Edit details'), Lxicon.edit, async () => {
				const current = await this.projects.readProject(project.id);
				if (current && !this.isDisposed && this.options.isVisible()) {
					this.options.showDialog({ project: current });
				}
			}),
			...getProjectRemovalActions(this.dialogs, project.name, {
				archive: () => this.commands.executeCommand<boolean>(ARCHIVE_PROJECT_COMMAND, project.id, 'chat'),
				remove: { removesContents: false, run: async () => { await this.projects.remove(project); } },
			}, operation => this.runRemoval(operation), !this.projects.state.get().busy),
		];
	}

	private async runRemoval(operation: () => Promise<boolean | void>): Promise<void> {
		try {
			const completed = await operation();
			if (completed !== false && !this.isDisposed && this.options.isVisible()) this.options.focusList();
		} catch (error) {
			this.notifications.error(toErrorMessage(error));
		}
	}

	editConversationProject(read: (signal: AbortSignal) => Promise<ConversationProjectEditor>, instructionsOnly?: boolean): Promise<void> {
		return this.loadProjectEdit(async signal => ({ conversation: await read(signal), instructionsOnly }));
	}

	private async loadProjectEdit(read: (signal: AbortSignal) => Promise<ChatProjectEdit>): Promise<void> {
		const controller = new AbortController();
		this.readConversationProject.value = toDisposable(() => controller.abort());
		try {
			const edit = await read(controller.signal);
			if (!controller.signal.aborted && this.options.isVisible()) this.options.showDialog(edit);
		} catch (error) {
			if (!controller.signal.aborted && !isCancellationError(error)) this.notifications.error(toErrorMessage(error));
		}
	}
}

export function getProjectRemovalActions(
	dialogs: IDialogService,
	title: string,
	{ archive, remove }: Pick<SessionsCatalogProjectOperations, 'archive' | 'remove'>,
	run: (operation: () => Promise<boolean | void>) => Promise<void>,
	enabled = true,
): IAction[] {
	const actions: IAction[] = [];
	if (archive) {
		const label = localize('projects.archive', 'Archive');
		actions.push({
			id: ARCHIVE_PROJECT_COMMAND, label, tooltip: label, icon: Lxicon.archive,
			enabled, run: () => run(archive)
		});
	}
	if (remove) {
		const label = localize('projects.delete', 'Delete');
		actions.push({
			id: 'projects.delete', label, tooltip: label, icon: Lxicon.trash, destructive: true,
			enabled, run: async () => {
				if (await confirmProjectDelete(dialogs, title, remove.removesContents)) await run(remove.run);
			}
		});
	}
	return actions;
}

export async function confirmProjectDelete(dialogs: IDialogService, title: string, removesContents: boolean): Promise<boolean> {
	const result = await dialogs.confirm({
		message: localize('projects.deleteConfirm', 'Delete project "{0}"?', title),
		detail: removesContents
			? localize('projects.deleteContentsDetail', 'This permanently deletes the project, its conversations and instructions, and files stored only in the project.')
			: localize('projects.deleteDetail', 'The project and its material references will be removed. Conversations and source files will be kept.'),
		primaryButton: localize('projects.delete', 'Delete'),
		destructive: true,
	});
	return result.confirmed;
}
