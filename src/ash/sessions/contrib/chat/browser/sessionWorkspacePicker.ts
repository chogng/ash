import { ActionWidgetDropdown } from '../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { SessionWorkspaceFallback } from './sessionWorkspaceFallback.js';
import { URI } from '../../../../base/common/uri.js';
import { observableValue } from '../../../../base/common/observable.js';
import { IWorkspacesService, type IRecentlyOpened } from '../../../../platform/workspaces/common/workspaces.js';
import { isRemoteResource } from '../../../../platform/remote/common/remote.js';
import { WorkspaceSelectionOrigin, type IWorkspaceSelectionSnapshot } from '../../../common/workspaceSelection.js';
import { h } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { CancellationTokenSource, type CancellationToken } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { IActionWidgetService } from '../../../../platform/actionWidget/browser/actionWidget.js';
import { ActionListItemKind, type IActionListItem } from '../../../../platform/actionWidget/browser/actionList.js';
import type { IAction } from '../../../../base/common/actions.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import type { IManagedHover } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { getHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import type { IChatWidgetModel } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import type { IAgentHostSessionsProvider } from '../../../common/agentHostSessionsProvider.js';
import { buildAgentHostSessionWorkspace, selectionFromResource, selectionFromWorkspace } from '../../../common/agentHostSessionWorkspace.js';
import { sessionWorkspaceUri } from '../../../common/sessionWorkspace.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import type { IUntitledChatSession, SessionExecutionTarget } from '../../../services/sessions/common/session.js';

const MAX_NEW_PICKER_RECENT_WORKSPACES = 10;

interface IWorkspacePickerAction extends IAction {
	readonly recent?: boolean;
}

interface IWorkspaceModeItem {
	readonly recent?: boolean;
	readonly label: string;
	readonly description?: string;
	readonly picked?: boolean;
	readonly mode: 'workspace' | 'container' | 'browse' | 'worktree' | 'folder';
	readonly target?: SessionExecutionTarget;
}

/** Edits the owning draft; container startup remains part of first-send preparation. */
export class SessionWorkspacePicker extends Disposable {
	private readonly picker: WorkspacePicker;
	private readonly host: HTMLElement;
	private readonly workspaceFallback: SessionWorkspaceFallback;
	private readonly presentationChanged = this._register(new Emitter<void>());
	private label = '';
	private tooltip = '';
	private enabled = false;
	private pickerDraft: IUntitledChatSession | undefined;
	private readonly pending = this._register(new MutableDisposable<DisposableStore>());
	private pendingDraftId: string | undefined;
	private visible = true;

	constructor(
		container: HTMLElement,
		private readonly model: IChatWidgetModel,
		@IInstantiationService instantiation: IInstantiationService,
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@ISessionsProvidersService private readonly providers: ISessionsProvidersService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@INotificationService private readonly notifications: INotificationService,
		@IFileDialogService private readonly fileDialogs: IFileDialogService,
		@IActionWidgetService actionWidget: IActionWidgetService,
		@IWorkspacesService private readonly workspaces: IWorkspacesService,
	) {
		super();
		const host = this.host = h(container.ownerDocument, 'div', { className: 'ash-sessions-chat-input-workspace' });
		container.prepend(host);
		this._register(toDisposable(() => host.remove()));
		const owner = this;
		this.workspaceFallback = instantiation.createInstance(SessionWorkspaceFallback);
		this.picker = this._register(instantiation.createInstance(WorkspacePicker, {
			trigger: {
				actionWidget,
				action: {
					id: 'sessions.chat.workspace', icon: Lxicon.folder,
					get label() { return owner.label; },
					get tooltip() { return owner.tooltip; },
					get enabled() { return owner.enabled; },
					run: () => this.showPicker(),
				},
				onDidChange: this.presentationChanged.event,
				placeholder: localize('sessions.workspace.searchFolders', 'Search folders'),
			},
		}));
		this.picker.render(host);
		this._register(sessions.onDidChange(() => this.render()));
		this._register(model.onDidChange(() => this.render()));
		this._register(workspace.onDidChangeWorkspaceFolders(() => this.render()));
		this.render();
	}

	private get draft(): IUntitledChatSession | undefined {
		return this.sessions.untitledSessions.find(draft => draft.untitledSessionId === this.model.untitledSessionId);
	}

	public setVisible(visible: boolean): void {
		this.visible = visible;
		if (!visible) { this.pending.clear(); this.picker.hide({ restoreFocus: false }); }
	}

	private render(): void {
		const draft = this.draft;
		this.host.hidden = !draft;
		const session = this.sessions.sessions.find(session => session.sessionId === this.model.sessionId);
		const selection = draft?.workspace;
		const root = selection && 'root' in selection ? selection.root : session?.workspace?.root;
		const name = root?.replace(/[/\\]+$/, '').split(/[/\\]/).pop()
			|| this.workspace.getWorkspace().folders.map(folder => folder.name).join(', ')
			|| localize('sessions.workspace.select', 'Select workspace');
		let label = draft?.devContainer || session?.workspace?.runtime?.providerId === 'ash.dev-containers'
			? localize('sessions.workspace.containerLabel', 'Dev Container · {0}', name) : name;
		if (draft?.branchName) {
			label = localize('sessions.workspace.worktreeLabel', 'Worktree · {0}', draft.branchName);
		}
		this.label = label;
		this.tooltip = localize('sessions.workspace.label', 'Workspace: {0}', root ? `${label}\n${root}` : label);
		this.enabled = !!draft && !this.model.inputState.aiDisabled && this.model.inputState.phase !== 'submitting';
		if (!this.enabled || this.pendingDraftId && this.pendingDraftId !== draft?.untitledSessionId) { this.pending.clear(); }
		if (this.pickerDraft && (this.pickerDraft.untitledSessionId !== draft?.untitledSessionId || this.pickerDraft.workspace !== draft?.workspace)) {
			this.picker.hide({ restoreFocus: false });
		}
		this.presentationChanged.fire();
	}

	public showPicker(): void {
		const draft = this.draft;
		if (!draft || !this.enabled || !this.visible) { return; }
		this.pending.clear();
		this.picker.focus();
		this.pickerDraft = draft;
		const selected = draft.workspace.type === 'current' ? selectionFromWorkspace(this.workspace.getWorkspace()) : draft.workspace;
		const source = selected.type === 'local' || selected.type === 'ssh' || selected.type === 'remote' ? selected : undefined;
		const toAction = (item: IWorkspaceModeItem): IWorkspacePickerAction => ({
			recent: item.recent,
			id: `sessions.workspace.${item.mode}.${item.target?.root ?? ''}`,
			label: item.label, tooltip: item.description ?? '', enabled: true, checked: item.picked,
			icon: item.mode === 'folder' || item.mode === 'browse' ? Lxicon.folder : undefined,
			run: async () => {
				if (this.isDisposed || !this.visible || !this.enabled || this.draft?.untitledSessionId !== draft.untitledSessionId
					|| this.draft.workspace !== draft.workspace) { return; }
				if (item.mode === 'browse' || item.mode === 'worktree' && !item.target) {
					await this.selectWorkspace(draft, item.mode, source);
				} else {
					this.sessions.setUntitledSessionWorkspace(draft.untitledSessionId, item.target ?? source ?? draft.workspace, { devContainer: item.mode === 'container' });
					status(item.label);
					if (item.mode === 'folder' && item.target) { await this.recordRecentFolder(item.target); }
				}
			},
		});
		const actions = [
			toAction({ label: localize('sessions.workspace.changeFolder', 'Open Folder…'), mode: 'browse' }),
		];
		this.picker.showPicker(actions, async token => {
			const folders = selectionFromWorkspace(this.workspace.getWorkspace());
			const workspaceFolders = folders.type === 'multiple' ? folders.folders
				: folders.type === 'current' ? [] : [{ label: folders.root, target: folders }];
			const accepts = (candidate: SessionExecutionTarget): boolean =>
				source?.type === 'ssh' ? candidate.type === 'ssh' && candidate.host === source.host
					: source?.type === 'remote' ? candidate.type === 'remote' && candidate.authority === source.authority
						: candidate.type === 'local';
			const candidates = workspaceFolders.filter(folder => accepts(folder.target));
			const provider = this.providers.getProvider(draft.providerId ?? '') as IAgentHostSessionsProvider | undefined;
			const [containerResult, worktreeResult, historyResult] = await Promise.allSettled([
				source && provider?.isDevContainerWorkspaceAvailable?.(sessionWorkspaceUri(buildAgentHostSessionWorkspace(source)!), token),
				source && provider?.getWorktrees?.(source, token),
				this.picker.getRecentFolders(candidates, accepts),
			]);
			if (token.isCancellationRequested) { return []; }
			const items: IWorkspaceModeItem[] = [];
			if (containerResult.status === 'fulfilled' && containerResult.value) {
				items.push({ label: localize('sessions.workspace.useHost', 'Use workspace host'), mode: 'workspace', picked: !draft.devContainer });
				items.push({ label: localize('sessions.workspace.useContainer', 'Use Dev Container'), mode: 'container', picked: draft.devContainer });
			}
			if (worktreeResult.status === 'fulfilled' && worktreeResult.value?.length) {
				items.push({ label: localize('sessions.workspace.newWorktree', 'New worktree…'), mode: 'worktree' });
				items.push(...worktreeResult.value.map(worktree => ({
					label: localize('sessions.workspace.worktreeLabel', 'Worktree · {0}', worktree.label),
					description: worktree.target.root, mode: 'worktree' as const, target: worktree.target,
				})));
			}
			for (const result of [containerResult, worktreeResult]) {
				if (result.status === 'rejected' && !isCancellationError(result.reason)) { this.notifications.error(result.reason); }
			}
			const folderAction = (folder: typeof candidates[number], recent: boolean) => toAction({
				recent, label: folder.label, description: folder.target.root, mode: 'folder', target: folder.target,
				picked: source?.type === folder.target.type && source.root === folder.target.root,
			});
			const recents = historyResult.status === 'fulfilled' ? historyResult.value : [];
			const known = new Set([...candidates, ...recents].map(({ target }) => sessionWorkspaceUri(buildAgentHostSessionWorkspace(target)!).toString()));
			const sessionFolders = this.workspaceFallback.getWorkspaces(draft.providerId, known, accepts);
			return [
				...candidates.map(folder => folderAction(folder, false)),
				...[...recents, ...sessionFolders].map(folder => folderAction(folder, true)),
				...actions,
				...items.map(toAction),
			];
		});
	}

	private async selectWorkspace(draft: IUntitledChatSession, mode: 'browse' | 'worktree', source: SessionExecutionTarget | undefined): Promise<void> {
		const lifetime = new DisposableStore();
		this.pending.value = lifetime;
		this.pendingDraftId = draft.untitledSessionId;
		const cancellation = new CancellationTokenSource();
		lifetime.add(toDisposable(() => cancellation.dispose(true)));
		lifetime.add(toDisposable(() => {
			this.pendingDraftId = undefined;
			if (!this.isDisposed && this.enabled && this.visible) { this.picker.focus(); }
		}));
		try {
			let target = source;
			let branchName: string | undefined;
			if (mode === 'browse') {
				if (source && source.type !== 'local') {
					const root = await this.quickInput.input({
						title: localize('sessions.workspace.browseTitle', 'Choose a conversation folder'),
						value: source.root,
						placeHolder: localize('sessions.workspace.remotePath', 'Absolute folder path on this conversation’s host'),
						validateInput: async value => value.startsWith('/') && !value.includes('\0') ? undefined
							: localize('sessions.workspace.absolutePath', 'Enter an absolute folder path.'),
					}, cancellation.token);
					if (root === undefined) { return; }
					target = { ...source, root };
				} else {
					const defaultUri = source && sessionWorkspaceUri(buildAgentHostSessionWorkspace(source)!);
					const folders = await this.fileDialogs.showOpenDialog({
						title: localize('sessions.workspace.browseTitle', 'Choose a conversation folder'),
						canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri,
					});
					if (!folders?.[0]) { return; }
					target = selectionFromResource(folders[0]);
				}
			} else {
				branchName = await this.quickInput.input({
					title: localize('sessions.workspace.newWorktree', 'New worktree…'),
					placeHolder: localize('sessions.workspace.branchPrompt', 'New branch name; created when you send the first message'),
					value: draft.branchName,
					validateInput: async value => {
						const name = value.trim();
						if (!name || name.length > 1024 || name === '@' || name.startsWith('-') || name.endsWith('.')
							|| name.includes('..') || name.includes('@{') || /[\x00-\x20\x7f~^:?*\\[\]]/u.test(name)
							|| name.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) {
							return localize('sessions.workspace.branchRequired', 'Enter a valid new Git branch name.');
						}
						return undefined;
					},
				}, cancellation.token);
				if (branchName === undefined) { return; }
				branchName = branchName.trim();
			}
			// Native dialogs may outlive their composer; a late result must not change another draft.
			if (target && !cancellation.token.isCancellationRequested && this.draft?.untitledSessionId === draft.untitledSessionId
				&& this.draft.workspace === draft.workspace && this.model.inputState.phase !== 'submitting') {
				this.sessions.setUntitledSessionWorkspace(draft.untitledSessionId, target, { branchName });
				status(localize('sessions.workspace.selected', 'Conversation folder: {0}', target.root));
				if (mode === 'browse') { await this.recordRecentFolder(target); }
			}
		} finally {
			lifetime.dispose();
		}
	}

	private async recordRecentFolder(target: SessionExecutionTarget): Promise<void> {
		const folderUri = sessionWorkspaceUri(buildAgentHostSessionWorkspace(target)!);
		const label = target.root.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || target.root;
		await this.workspaces.addRecentlyOpened([{ folderUri, label }]);
	}

}

/** Owns Sessions workspace triggers, folder history and the cancellation scope of each selection. */
export class WorkspacePicker extends Disposable {
	private readonly pending = this._register(new MutableDisposable<DisposableStore>());
	private readonly snapshot = observableValue<IWorkspaceSelectionSnapshot>(this, {
		folderUri: undefined, origin: WorkspaceSelectionOrigin.None, state: 'none', historyState: 'loading',
	});

	private button!: Button;
	private hover!: IManagedHover;
	private dropdown: ActionWidgetDropdown | undefined;

	constructor(
		private readonly options: { readonly trigger?: { readonly actionWidget: IActionWidgetService; readonly action: IAction; readonly onDidChange: Event<void>; readonly placeholder: string; }; },
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IWorkspacesService private readonly workspaces: IWorkspacesService,
		@INotificationService private readonly notifications: INotificationService,
	) { super(); }

	public render(container: HTMLElement): void {
		const trigger = this.options.trigger!;
		this.button = this._register(new Button(container, {
			...defaultButtonStyles,
			label: trigger.action.label, icon: trigger.action.icon, size: 'small',
		}));
		this.button.domNode.classList.add('ash-sessions-workspace-picker');
		this.dropdown = this._register(new ActionWidgetDropdown(container, {
			label: trigger.action.label, ariaLabel: trigger.action.tooltip,
			trigger: { button: this.button, open: () => { trigger.action.run(); } },
			onError: error => this.reportError(error),
			listOptions: {
				className: 'ash-action-widget-accent-checks',
				showFilter: true,
				focusFilterOnOpen: true,
				filterPlaceholder: trigger.placeholder,
				ariaLabel: trigger.placeholder,
			},
		}, trigger.actionWidget));
		this.hover = this._register(getHoverDelegate().setupHover({ target: this.button.domNode, content: trigger.action.tooltip }));
		const update = (): void => {
			this.button.label = trigger.action.label;
			this.button.enabled = trigger.action.enabled;
			this.button.domNode.setAttribute('aria-label', trigger.action.tooltip);
			this.hover.update(trigger.action.tooltip);
			this.button.domNode.tabIndex = trigger.action.enabled ? 0 : -1;
			if (!trigger.action.enabled) { this.hide({ restoreFocus: false }); }
		};
		this._register(trigger.onDidChange(update));
		update();
	}
	public focus(): void {
		if (!this.isDisposed && this.options.trigger!.action.enabled) { this.button.focus(); }
	}

	/** Show immediate choices while loading provider capabilities within this popup's cancellation scope. */
	public showPicker(actions: readonly IWorkspacePickerAction[], loadActions?: (token: CancellationToken) => Promise<readonly IWorkspacePickerAction[]>): void {
		if (this.isDisposed || !this.options.trigger!.action.enabled) { return; }
		const toItems = (choices: readonly IWorkspacePickerAction[]): readonly IActionListItem<IWorkspacePickerAction>[] => choices.map(action => ({
			kind: ActionListItemKind.Action, id: action.id, label: action.label, description: action.tooltip,
			disabled: !action.enabled, checked: action.checked, item: action,
			group: action.icon ? { title: '', icon: action.icon } : undefined,
		}));
		this.dropdown?.showItems({
			load: () => toItems(actions),
			refresh: loadActions && (async token => toItems(await loadActions(token))),
			filterItems: (items, query) => {
				if (query.trim()) { return items; }
				let recentCount = 0;
				return items.filter(entry => !entry.item?.recent || ++recentCount <= MAX_NEW_PICKER_RECENT_WORKSPACES);
			},
			select: action => action.run(),
			restoreFocusOnSelect: true,
		});
	}

	public hide(options?: { readonly restoreFocus: boolean; }): void {
		const wasOpen = this.button?.domNode.getAttribute('aria-expanded') === 'true';
		this.dropdown?.hide();
		if (wasOpen && options?.restoreFocus !== false && !this.isDisposed && this.button.domNode.isConnected) { this.focus(); }
	}

	private reportError(error: unknown): void {
		if (!this.isDisposed && !isCancellationError(error)) {
			this.notifications.error(error instanceof Error ? error : String(error));
		}
	}

	public async getRecentFolders(
		folders: readonly { readonly label: string; readonly target: SessionExecutionTarget; }[],
		accepts: (target: SessionExecutionTarget) => boolean,
	): Promise<readonly { readonly label: string; readonly target: SessionExecutionTarget; }[]> {
		const known = new Set(folders.map(({ target }) => sessionWorkspaceUri(buildAgentHostSessionWorkspace(target)!).toString()));
		return this.resolveRecentFolders(await this.workspaces.getRecentlyOpened(), known, accepts);
	}

	private resolveRecentFolders(history: IRecentlyOpened, known: Set<string>, accepts: (target: SessionExecutionTarget) => boolean) {
		return history.workspaces.flatMap(recent => {
			if (!('folderUri' in recent) || known.has(recent.folderUri.toString()) || (recent.folderUri.scheme !== 'file' && !isRemoteResource(recent.folderUri))) { return []; }
			let target: SessionExecutionTarget;
			try { target = selectionFromResource(recent.folderUri); }
			catch { return []; }
			if (!accepts(target)) { return []; }
			known.add(recent.folderUri.toString());
			return [{ label: recent.label ?? recent.folderUri.path, target }];
		});
	}

	public pick(folders: readonly { readonly label: string; readonly target: SessionExecutionTarget; }[], accepts: (target: SessionExecutionTarget) => boolean = () => true): Promise<SessionExecutionTarget | undefined> {
		this.pending.clear();
		if (this.isDisposed) { return Promise.resolve(undefined); }
		const lifetime = new DisposableStore();
		this.pending.value = lifetime;
		const picker = lifetime.add(this.quickInput.createQuickPick<{ label: string; description: string; folderUri: URI; target: SessionExecutionTarget; origin: WorkspaceSelectionOrigin; }>());
		picker.items = folders.filter(folder => accepts(folder.target)).map(folder => ({
			label: folder.label, description: folder.target.root,
			folderUri: sessionWorkspaceUri(buildAgentHostSessionWorkspace(folder.target)!), target: folder.target,
			origin: WorkspaceSelectionOrigin.WindowContext,
		}));
		picker.placeholder = localize('sessions.selectExecutionFolder', 'Select a folder for this session');
		picker.ariaLabel = picker.placeholder;
		picker.busy = true;
		this.snapshot.set({ folderUri: undefined, origin: WorkspaceSelectionOrigin.None, target: undefined, state: picker.items.length ? 'unresolved' : 'noWorkspace', historyState: 'loading' });
		return new Promise(resolve => {
			let settled = false;
			const finish = (target: SessionExecutionTarget | undefined): void => {
				if (settled) { return; }
				settled = true;
				resolve(target);
				lifetime.dispose();
			};
			lifetime.add(toDisposable(() => finish(undefined)));
			lifetime.add(picker.onDidAccept(() => {
				const item = picker.selectedItems[0];
				if (!item) { return; }
				this.snapshot.set({ ...this.snapshot.get(), folderUri: item.folderUri, target: item.target, origin: item.origin === WorkspaceSelectionOrigin.AgentsRecent ? item.origin : WorkspaceSelectionOrigin.User, state: 'selected' });
				finish(this.snapshot.get().target);
			}));
			lifetime.add(picker.onDidHide(() => finish(undefined)));
			picker.show();
			void this.workspaces.getRecentlyOpened().then(history => {
				if (settled) { return; }
				const known = new Set(picker.items.flatMap(item => 'folderUri' in item ? [item.folderUri.toString()] : []));
				const recents = this.resolveRecentFolders(history, known, accepts).map(({ label, target }) => ({
					label, description: target.root, folderUri: sessionWorkspaceUri(buildAgentHostSessionWorkspace(target)!),
					target, origin: WorkspaceSelectionOrigin.AgentsRecent,
				}));
				picker.items = [...picker.items, ...recents];
				picker.busy = false;
				this.snapshot.set({ ...this.snapshot.get(), historyState: 'loaded' });
			}, () => {
				if (settled) { return; }
				picker.busy = false;
				this.snapshot.set({ ...this.snapshot.get(), historyState: 'error' });
			});
		});
	}
}
