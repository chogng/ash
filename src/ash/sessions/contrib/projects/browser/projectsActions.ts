import type { IAction } from '../../../../base/common/actions.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { Project, ProjectSummary } from '../../../../platform/projects/common/projectService.js';
import type { ChatListGroup, ConversationProjectEditor } from '../../chat/browser/chatListModel.js';
import { IProjectsService, type ProjectSortOrder } from './projectsService.js';

interface ProjectsActionOptions {
	readonly showDialog: (project?: Project, conversation?: ConversationProjectEditor) => void;
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
		const editLabel = localize('projects.edit', 'Edit details');
		const editActions: IAction[] = editor ? [{
			id: 'projects.edit',
			label: editLabel,
			tooltip: editLabel,
			icon: Lxicon.edit,
			enabled: true,
			run: () => this.editConversationProject(editor),
		}] : [];
		const archive = project.project?.archive;
		const remove = project.project?.remove;
		return [...editActions, ...this.projectRemovalActions(project.title, archive, remove)];
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
					this.options.showDialog(current);
				}
			}),
			...this.projectRemovalActions(project.name, async () => { await this.projects.archive(project); }, {
				removesContents: false,
				run: async () => { await this.projects.remove(project); },
			}),
		];
	}

	private projectRemovalActions(
		title: string,
		archive: (() => void | Promise<void>) | undefined,
		remove: { readonly removesContents: boolean; run(): Promise<void>; } | undefined,
	): IAction[] {
		const run = async (operation: () => void | Promise<void>): Promise<void> => {
			try {
				await operation();
				if (!this.isDisposed && this.options.isVisible()) this.options.focusList();
			} catch (error) {
				this.notifications.error(toErrorMessage(error));
			}
		};
		const actions: IAction[] = [];
		if (archive) {
			const label = localize('projects.archive', 'Archive');
			actions.push({
				id: 'projects.archive', label, tooltip: label, icon: Lxicon.archive,
				enabled: !this.projects.state.get().busy, run: () => run(archive)
			});
		}
		if (remove) {
			const label = localize('projects.delete', 'Delete');
			actions.push({
				id: 'projects.delete', label, tooltip: label, icon: Lxicon.trash,
				enabled: !this.projects.state.get().busy, run: async () => {
					const result = await this.dialogs.confirm({
						message: localize('projects.deleteConfirm', 'Delete project "{0}"?', title),
						detail: remove.removesContents
							? localize('projects.deleteContentsDetail', 'This permanently deletes the project, its conversations and instructions, and files stored only in the project.')
							: localize('projects.deleteDetail', 'The project and its material references will be removed. Conversations and source files will be kept.'),
						primaryButton: label,
					});
					if (result.confirmed) await run(remove.run);
				}
			});
		}
		return actions;
	}

	private async editConversationProject(read: (signal: AbortSignal) => Promise<ConversationProjectEditor>): Promise<void> {
		const controller = new AbortController();
		this.readConversationProject.value = toDisposable(() => controller.abort());
		try {
			const editor = await read(controller.signal);
			if (!controller.signal.aborted && this.options.isVisible()) this.options.showDialog(undefined, editor);
		} catch (error) {
			if (!controller.signal.aborted) this.notifications.error(toErrorMessage(error));
		}
	}
}
