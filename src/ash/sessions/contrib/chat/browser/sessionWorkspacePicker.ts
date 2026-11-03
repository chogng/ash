import { trackChatInputPickerFocus } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputPickerActionItem.js';
import { ActionWidgetDropdown } from '../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { SessionsRecentWorkspacesService } from '../../../services/sessions/browser/sessionsRecentWorkspacesService.js';
import { SessionWorkspaceFallback } from './sessionWorkspaceFallback.js';
import { URI } from '../../../../base/common/uri.js';
import { createUuid } from '../../../../base/common/uuid.js';
import { basename } from '../../../../base/common/resources.js';
import { observableValue } from '../../../../base/common/observable.js';
import { IWorkspacesService, type IRecentlyOpened } from '../../../../platform/workspaces/common/workspaces.js';
import { isRemoteResource } from '../../../../platform/remote/common/remote.js';
import { WorkspaceSelectionOrigin, type IWorkspaceSelectionSnapshot } from '../../../common/workspaceSelection.js';
import { h } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { CancellationTokenSource, type CancellationToken } from '../../../../base/common/cancellation.js';
import { structuralEquals } from '../../../../base/common/equals.js';
import { getErrorMessage, isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ILocalGitService } from '../../../../platform/git/common/localGitService.js';
import { cloneRepository } from '../../../services/sessions/browser/cloneRepository.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { IActionWidgetService } from '../../../../platform/actionWidget/browser/actionWidget.js';
import { ActionListItemKind, type IActionListItem, type IActionListItemInlineToggle } from '../../../../platform/actionWidget/browser/actionList.js';
import { Separator, type IAction } from '../../../../base/common/actions.js';
import type { IManagedHover } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { getHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import type { IChatWidgetModel } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID, type IAgentHostSessionsProvider } from '../../../common/agentHostSessionsProvider.js';
import { buildAgentHostSessionWorkspace, selectionFromResource, selectionFromWorkspace } from '../../../common/agentHostSessionWorkspace.js';
import { sessionWorkspaceUri } from '../../../common/sessionWorkspace.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import type { IUntitledChatSession, SessionExecutionTarget } from '../../../services/sessions/common/session.js';

const MAX_NEW_PICKER_RECENT_WORKSPACES = 10;

type WorktreeCatalog = Awaited<ReturnType<NonNullable<IAgentHostSessionsProvider['getWorktrees']>>>;

interface IWorkspaceWorktreeQuery {
	readonly provider: IAgentHostSessionsProvider;
	readonly sourceKey: string;
	readonly result: Promise<WorktreeCatalog>;
	worktrees?: WorktreeCatalog;
	opened?: boolean;
	error?: unknown;
}

interface IWorkspacePickerAction extends IAction {
	readonly recent?: boolean;
	readonly rowTooltip?: string;
	readonly submenu?: readonly IWorkspacePickerAction[];
	readonly standaloneToggle?: IActionListItemInlineToggle;
}

interface IWorkspaceModeItem {
	readonly recent?: boolean;
	readonly label: string;
	readonly picked?: boolean;
	readonly mode: 'workspace' | 'container' | 'browse' | 'clone' | 'worktree' | 'folder';
	readonly target?: SessionExecutionTarget;
}

/** Edits the owning draft; container startup remains part of first-send preparation. */
export class SessionWorkspacePicker extends Disposable {
	private readonly picker: WorkspacePicker;
	private readonly host: HTMLElement;
	private readonly workspaceFallback: SessionWorkspaceFallback;
	private readonly recentWorkspaces: SessionsRecentWorkspacesService;
	private readonly presentationChanged = this._register(new Emitter<void>());
	private label = '';
	private tooltip = '';
	private enabled = false;
	private pickerDraft: IUntitledChatSession | undefined;
	private readonly pending = this._register(new MutableDisposable<DisposableStore>());
	private pendingDraftId: string | undefined;
	private visible = true;
	private readonly worktreeRequest = this._register(new MutableDisposable());
	private worktreeQuery: IWorkspaceWorktreeQuery | undefined;

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
		@ILocalGitService private readonly git: ILocalGitService,
	) {
		super();
		const host = this.host = h(container.ownerDocument, 'div', { className: 'ash-sessions-chat-input-workspace' });
		container.prepend(host);
		this._register(toDisposable(() => host.remove()));
		const owner = this;
		this.workspaceFallback = instantiation.createInstance(SessionWorkspaceFallback);
		this.recentWorkspaces = instantiation.createInstance(SessionsRecentWorkspacesService);
		this.picker = this._register(instantiation.createInstance(WorkspacePicker, {
			trigger: {
				actionWidget,
				action: {
					id: 'sessions.chat.workspace', icon: Lxicon.folder,
					get label() { return owner.label; },
					get tooltip() { return owner.tooltip; },
					get enabled() { return owner.enabled; },
					run: () => this.openPicker(),
				},
				onDidChange: this.presentationChanged.event,
				placeholder: localize('sessions.workspace.searchFolders', 'Search folders'),
			},
		}));
		this.picker.render(host);
		this._register(sessions.onDidChange(() => this.render()));
		this._register(model.onDidChange(() => this.render()));
		this._register(workspace.onDidChangeWorkspaceFolders(() => this.render()));
		this._register(providers.onDidChangeProviders(() => this.render()));
		this.render();
	}

	private get draft(): IUntitledChatSession | undefined {
		return this.sessions.untitledSessions.find(draft => draft.untitledSessionId === this.model.untitledSessionId);
	}

	public setVisible(visible: boolean): void {
		this.visible = visible;
		if (visible) {
			this.prepareWorktrees(this.draft);
		} else {
			this.pending.clear();
			this.picker.hide();
			this.prepareWorktrees(undefined);
		}
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
		const label = draft?.devContainer || session?.workspace?.runtime?.providerId === 'ash.dev-containers'
			? localize('sessions.workspace.containerLabel', 'Dev Container · {0}', name) : name;
		this.label = label;
		this.tooltip = localize('sessions.workspace.label', 'Workspace: {0}', root ? `${label}\n${root}` : label);
		this.enabled = !!draft && !this.model.inputState.aiDisabled && this.model.inputState.phase !== 'submitting';
		if (!this.enabled || this.pendingDraftId && this.pendingDraftId !== draft?.untitledSessionId) { this.pending.clear(); }
		if (this.pickerDraft && (this.pickerDraft.untitledSessionId !== draft?.untitledSessionId || this.pickerDraft.workspace !== draft?.workspace)) {
			this.picker.hide();
		}
		this.prepareWorktrees(this.visible ? draft : undefined);
		this.presentationChanged.fire();
	}

	public showPicker(): void {
		if (!this.visible) { return; }
		this.picker.focus();
		this.openPicker();
	}

	private workspaceSource(draft: IUntitledChatSession): SessionExecutionTarget | undefined {
		const selected = draft.workspace.type === 'current' ? selectionFromWorkspace(this.workspace.getWorkspace()) : draft.workspace;
		return selected.type === 'local' || selected.type === 'ssh' || selected.type === 'remote' ? selected : undefined;
	}

	private prepareWorktrees(draft: IUntitledChatSession | undefined, refresh = false): IWorkspaceWorktreeQuery | undefined {
		const source = draft && this.workspaceSource(draft);
		const provider = draft && this.providers.getProvider(draft.providerId ?? '') as IAgentHostSessionsProvider | undefined;
		if (!source || !provider?.getWorktrees) {
			this.worktreeRequest.clear();
			return this.worktreeQuery = undefined;
		}
		const sourceKey = sessionWorkspaceUri(buildAgentHostSessionWorkspace(source)!).toString();
		const previous = this.worktreeQuery;
		const sameSource = previous?.provider === provider && previous.sourceKey === sourceKey;
		if (sameSource && (!refresh || !previous.opened || previous.worktrees === undefined)) {
			if (refresh) previous.opened = true;
			return previous;
		}

		const cancellation = new CancellationTokenSource();
		this.worktreeRequest.value = toDisposable(() => cancellation.dispose(true));
		const query: IWorkspaceWorktreeQuery = {
			provider, sourceKey, opened: refresh, worktrees: sameSource ? previous.worktrees : undefined,
			result: Promise.resolve().then(() => {
				if (cancellation.token.isCancellationRequested) return [];
				return provider.getWorktrees!(source, cancellation.token, true);
			}).catch(error => {
				if (!cancellation.token.isCancellationRequested && !isCancellationError(error)) query.error = error;
				return [];
			}).then(worktrees => {
				query.worktrees = worktrees;
				return worktrees;
			}),
		};
		return this.worktreeQuery = query;
	}

	private openPicker(): void {
		const draft = this.draft;
		if (!draft || !this.enabled || !this.visible) { return; }
		this.pending.clear();
		this.pickerDraft = draft;
		const source = this.workspaceSource(draft);
		const worktreeQuery = this.prepareWorktrees(draft, true);
		const isCurrent = (): boolean => !this.isDisposed && this.visible && this.enabled
			&& this.draft?.untitledSessionId === draft.untitledSessionId
			&& this.draft.workspace === draft.workspace && this.draft.providerId === draft.providerId;
		const toAction = (item: IWorkspaceModeItem): IWorkspacePickerAction => ({
			recent: item.recent,
			id: `sessions.workspace.${item.mode}.${item.target?.root ?? ''}`,
			label: item.label, rowTooltip: item.mode === 'folder' ? item.target?.root : undefined,
			tooltip: item.target?.root ?? '', enabled: true, checked: item.picked,
			icon: item.mode === 'worktree' ? Lxicon.gitBranch
				: item.mode === 'clone' ? Lxicon.githubAlt
					: item.mode === 'folder' || item.mode === 'browse' ? Lxicon.folder : undefined,
			run: async () => {
				if (!isCurrent()) return;
				if (item.mode === 'browse' || item.mode === 'clone') {
					await this.selectWorkspace(draft, item.mode, source);
				} else {
					const current = this.draft!;
					this.sessions.setUntitledSessionWorkspace(draft.untitledSessionId, item.target ?? source ?? draft.workspace, {
						devContainer: item.mode === 'container' || item.mode === 'worktree' && current.devContainer,
						branchName: item.mode === 'worktree' ? current.branchName : undefined,
					});
					status(item.label);
					if (item.mode === 'folder' && item.target) { await this.recordRecentFolder(draft.providerId, item.target); }
				}
			},
		});
		const openFolder = toAction({ label: localize('sessions.workspace.changeFolder', 'Open Folder…'), mode: 'browse' });
		const actions: IWorkspacePickerAction[] = [];
		if ((!draft.providerId || draft.providerId === LOCAL_AGENT_HOST_PROVIDER_ID) && (!source || source.type === 'local')) {
			actions.push(toAction({ label: localize('sessions.workspace.cloneRepository', 'Clone Repository…'), mode: 'clone' }));
		}
		let allWorktrees = worktreeQuery?.worktrees;
		let hasContainer = false;
		let recents: Awaited<ReturnType<WorkspacePicker['getRecentFolders']>> = [];
		const workspace = this.workspace.getWorkspace();
		const folders = selectionFromWorkspace(workspace);
		const workspaceFolders = folders.type === 'multiple' ? folders.folders
			: folders.type === 'current' ? [] : [{ label: workspace.folders[0]!.name, target: folders }];
		const accepts = (candidate: SessionExecutionTarget): boolean =>
			source?.type === 'ssh' ? candidate.type === 'ssh' && candidate.host === source.host
				: source?.type === 'remote' ? candidate.type === 'remote' && candidate.authority === source.authority
					: candidate.type === 'local';
		const candidates = workspaceFolders.filter(folder => accepts(folder.target));
		const buildActions = () => {
			const environmentItems: IWorkspaceModeItem[] = [];
			if (hasContainer) {
				environmentItems.push({ label: localize('sessions.workspace.useHost', 'Use workspace host'), mode: 'workspace', picked: !draft.devContainer });
				environmentItems.push({ label: localize('sessions.workspace.useContainer', 'Use Dev Container'), mode: 'container', picked: draft.devContainer });
			}
			const worktreesOnHost = allWorktrees ?? [];
			const folderUri = (target: SessionExecutionTarget): URI => sessionWorkspaceUri(buildAgentHostSessionWorkspace(target)!);
			const sourceKey = source && folderUri(source).toString();
			const sourceRepositories = new Set(worktreesOnHost.flatMap(worktree => {
				if (!worktree.repository) return [];
				const repository = folderUri(worktree.repository).toString();
				return folderUri(worktree.target).toString() === sourceKey || repository === sourceKey ? [repository] : [];
			}));
			const sourceWorktrees = worktreesOnHost.filter(worktree => !worktree.repository || sourceRepositories.has(folderUri(worktree.repository).toString()));
			const worktreeActions: IWorkspacePickerAction[] = [];
			const loadingWorktrees = !!worktreeQuery && allWorktrees === undefined;
			if (source && (loadingWorktrees || sourceWorktrees.length)) {
				const branches = sourceWorktrees.map(worktree => toAction({
					label: worktree.label, mode: 'worktree', target: worktree.target,
					picked: folderUri(worktree.target).toString() === sourceKey,
				}));
				const owner = this;
				const worktreeLabel = localize('sessions.workspace.newWorktree', 'New worktree');
				worktreeActions.push({
					id: 'sessions.workspace.branches',
					label: loadingWorktrees ? localize('sessions.workspace.loadingBranches', 'Loading branches…')
						: branches.find(branch => branch.checked)?.label ?? localize('sessions.workspace.branch', 'Branch'),
					tooltip: branches.map(branch => branch.label).join(' '),
					enabled: !loadingWorktrees, icon: Lxicon.gitBranch, submenu: loadingWorktrees ? undefined : branches,
					run: () => { },
				}, {
					id: 'sessions.workspace.newWorktree',
					label: worktreeLabel,
					tooltip: '', enabled: !loadingWorktrees, icon: Lxicon.worktree,
					run: () => { },
					standaloneToggle: {
						label: worktreeLabel,
						get checked() { return !!owner.draft?.branchName; },
						onChange: checked => {
							if (!isCurrent()) return;
							const current = this.draft!;
							// Keep the generated name in the draft so first-send retries use the same branch.
							const workspace = current.workspace.type === 'current' ? source : current.workspace;
							try {
								this.sessions.setUntitledSessionWorkspace(current.untitledSessionId, workspace, {
									devContainer: current.devContainer,
									branchName: checked ? current.branchName ?? `ash/${createUuid()}` : undefined,
								});
							} catch (error) {
								this.notifications.error(getErrorMessage(error));
							}
						},
					},
				});
			}
			const folderAction = (folder: typeof candidates[number], recent: boolean) => toAction({
				recent, label: folder.label, mode: 'folder', target: folder.target,
				picked: source?.type === folder.target.type && source.root === folder.target.root,
			});
			const known = new Set([...candidates, ...recents].map(({ target }) => sessionWorkspaceUri(buildAgentHostSessionWorkspace(target)!).toString()));
			const sessionFolders = this.workspaceFallback.getWorkspaces(draft.providerId, known, accepts);
			// Only fold checkouts confirmed by the current host. Other recent folders remain
			// selectable even when their names resemble a worktree.
			const worktrees = new Set(sourceWorktrees.map(worktree => folderUri(worktree.target).toString()));
			const recentFolders = [...recents, ...sessionFolders].filter(folder => !worktrees.has(folderUri(folder.target).toString()));
			const hidden = this.recentWorkspaces.getHidden();
			const visibleFolders = new Set([
				...candidates.map(folder => folderUri(folder.target).toString()),
				...recentFolders.map(folder => folderUri(folder.target).toString()).filter(key => !hidden.has(key)),
			]);
			const collapsed = new Set(worktreesOnHost.flatMap(worktree => {
				if (!worktree.repository) return [];
				const checkout = folderUri(worktree.target).toString();
				const repository = folderUri(worktree.repository).toString();
				return checkout !== sourceKey && checkout !== repository && visibleFolders.has(repository) ? [checkout] : [];
			}));
			const manage: IAction = {
				id: 'sessions.workspace.manageRecent', label: localize('sessions.workspace.manageRecent', 'Manage Recent Folders…'),
				tooltip: '', enabled: true,
				run: () => {
					if (!isCurrent()) return;
					this.picker.showPicker(recentFolders.map(folder => {
						const uri = folderUri(folder.target);
						const wasHidden = hidden.has(uri.toString());
						const label = wasHidden
							? localize('sessions.workspace.restoreRecent', 'Restore {0}', folder.label)
							: localize('sessions.workspace.hideRecent', 'Hide {0}', folder.label);
						return {
							id: uri.toString(), label, tooltip: folder.target.root, enabled: true,
							run: () => {
								if (!isCurrent()) return;
								this.recentWorkspaces.setHidden(uri, !wasHidden);
								status(label);
								this.showPicker();
							},
						};
					}));
				},
			};
			const folderActions = [
				...candidates.map(folder => folderAction(folder, false)),
				...recentFolders.filter(folder => {
					const key = folderUri(folder.target).toString();
					return !hidden.has(key) && !collapsed.has(key);
				}).map(folder => folderAction(folder, true)),
			];
			return Separator.join(
				[...folderActions, ...environmentItems.map(toAction)],
				[...actions, ...(recentFolders.length ? [manage] : []), openFolder],
				worktreeActions,
			);
		};
		this.picker.showPicker(buildActions(), async (token, publish) => {
			const update = () => {
				if (!token.isCancellationRequested && isCurrent()) publish(buildActions());
			};
			const provider = this.providers.getProvider(draft.providerId ?? '') as IAgentHostSessionsProvider | undefined;
			await Promise.all([
				worktreeQuery?.result.then(result => {
					if (!token.isCancellationRequested && isCurrent() && worktreeQuery.error !== undefined) this.notifications.error(getErrorMessage(worktreeQuery.error));
					if (structuralEquals(allWorktrees, result)) return;
					allWorktrees = result;
					update();
				}),
				Promise.resolve(source && provider?.isDevContainerWorkspaceAvailable?.(sessionWorkspaceUri(buildAgentHostSessionWorkspace(source)!), token))
					.then(available => { if (available) { hasContainer = true; update(); } }, error => {
						if (!token.isCancellationRequested && !isCancellationError(error)) this.notifications.error(error);
					}),
				this.picker.getRecentFolders(candidates, accepts).then(result => { recents = result; if (recents.length) update(); }, () => { }),
			]);
		});
	}

	private async selectWorkspace(draft: IUntitledChatSession, mode: 'browse' | 'clone', source: SessionExecutionTarget | undefined): Promise<void> {
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
			if (mode === 'clone') {
				const title = localize('sessions.workspace.cloneRepository', 'Clone Repository…');
				const url = await this.quickInput.input({
					title,
					placeHolder: localize('sessions.workspace.cloneUrl', 'HTTPS, SSH or file Git repository URL'),
					validateInput: async value => cloneFolderName(value) ? undefined
						: localize('sessions.workspace.invalidCloneUrl', 'Enter a Git repository URL with a valid folder name.'),
				}, cancellation.token);
				const name = url === undefined ? undefined : cloneFolderName(url);
				if (!name || !url || cancellation.token.isCancellationRequested) { return; }
				const parent = (await this.fileDialogs.showOpenDialog({
					title: localize('sessions.workspace.cloneParent', 'Select a parent folder for the clone'),
					canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
					defaultUri: source?.type === 'local' ? URI.file(source.root) : undefined,
				}))?.[0];
				if (!parent || parent.scheme !== 'file' || parent.authority || cancellation.token.isCancellationRequested) { return; }
				target = selectionFromResource(await cloneRepository(this.git, url.trim(), parent, name, cancellation.token));
			} else {
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
			}
			// Native dialogs may outlive their composer; a late result must not change another draft.
			if (target && !cancellation.token.isCancellationRequested && this.draft?.untitledSessionId === draft.untitledSessionId
				&& this.draft.workspace === draft.workspace && this.draft.providerId === draft.providerId && this.model.inputState.phase !== 'submitting') {
				this.sessions.setUntitledSessionWorkspace(draft.untitledSessionId, target, { branchName: undefined });
				status(localize('sessions.workspace.selected', 'Conversation folder: {0}', target.root));
				await this.recordRecentFolder(draft.providerId, target);
			}
		} catch (error) {
			if (!cancellation.token.isCancellationRequested && !isCancellationError(error)) { this.notifications.error(getErrorMessage(error)); }
		} finally {
			lifetime.dispose();
		}
	}

	private async recordRecentFolder(providerId: string | undefined, target: SessionExecutionTarget): Promise<void> {
		if (providerId) this.recentWorkspaces.setSelected(providerId, target);
		const folderUri = sessionWorkspaceUri(buildAgentHostSessionWorkspace(target)!);
		const label = target.root.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || target.root;
		await this.workspaces.addRecentlyOpened([{ folderUri, label }]);
	}

}

// Restrict the derived name to one portable path segment before giving it to the host.
function cloneFolderName(input: string): string | undefined {
	const value = input.trim();
	let path: string;
	try {
		const url = new URL(value);
		if (url.password || url.search || url.hash) { return undefined; }
		if (url.protocol === 'file:') {
			if (url.hostname) { return undefined; }
		} else if (!['https:', 'ssh:'].includes(url.protocol) || !url.hostname) {
			return undefined;
		}
		path = url.pathname;
	} catch {
		const match = /^[\w.-]+@[\w.-]+:([^\s]+)$/.exec(value);
		if (!match) { return undefined; }
		path = match[1]!;
	}
	const name = path.replace(/\/+$/, '').split('/').pop()?.replace(/\.git$/i, '');
	return name && /^[a-z0-9_][a-z0-9_.-]*$/i.test(name) && !name.endsWith('.')
		&& !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
		&& !name.toLowerCase().endsWith('.code-workspace') ? name : undefined;
}

/** Owns Sessions workspace triggers, folder history and the cancellation scope of each selection. */
export class WorkspacePicker extends Disposable {
	private readonly pending = this._register(new MutableDisposable<DisposableStore>());
	private readonly snapshot = observableValue<IWorkspaceSelectionSnapshot>(this, {
		folderUri: undefined, origin: WorkspaceSelectionOrigin.None, state: 'none', historyState: 'loading',
	});

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
		const dropdown = this.dropdown = this._register(new ActionWidgetDropdown(container, {
			label: trigger.action.label, ariaLabel: trigger.action.tooltip,
			buttonOptions: { icon: trigger.action.icon, presentation: 'quiet', size: 'small' },
			onOpen: () => { trigger.action.run(); },
			tabLeavesPopup: true,
			onError: error => this.reportError(error),
			listOptions: {
				className: 'ash-action-widget-accent-checks',
				showRowTooltips: true,
				showFilter: true,
				focusFilterOnOpen: true,
				filterPlaceholder: trigger.placeholder,
				ariaLabel: trigger.placeholder,
			},
		}, trigger.actionWidget));
		dropdown.element.classList.add('ash-sessions-workspace-picker');
		this._register(trackChatInputPickerFocus(container));
		this.hover = this._register(getHoverDelegate().setupHover({ target: dropdown.element, content: trigger.action.tooltip }));
		const update = (): void => {
			dropdown.setLabel(trigger.action.label);
			dropdown.setEnabled(trigger.action.enabled);
			dropdown.element.tabIndex = trigger.action.enabled ? 0 : -1;
			dropdown.element.setAttribute('aria-label', trigger.action.tooltip);
			this.hover.update(trigger.action.tooltip);
		};
		this._register(trigger.onDidChange(update));
		update();
	}
	public focus(): void {
		this.dropdown?.focus();
	}

	/** Show immediate choices while loading provider capabilities within this popup's cancellation scope. */
	public showPicker(actions: readonly IWorkspacePickerAction[], loadActions?: (token: CancellationToken, publish: (actions: readonly IWorkspacePickerAction[]) => void) => Promise<readonly IWorkspacePickerAction[] | void>): void {
		if (this.isDisposed || !this.options.trigger!.action.enabled) { return; }
		const toItem = (action: IWorkspacePickerAction): IActionListItem<IWorkspacePickerAction> => action.id === Separator.ID ? {
			kind: ActionListItemKind.Separator, label: '',
		} : {
			kind: ActionListItemKind.Action, id: action.id, label: action.label,
			tooltip: action.rowTooltip,
			detail: action.tooltip,
			disabled: !action.enabled, checked: action.checked, item: action.standaloneToggle ? undefined : action,
			submenu: action.submenu?.map(toItem), standaloneToggle: action.standaloneToggle,
			group: action.icon ? { title: '', icon: action.icon } : undefined,
		};
		this.dropdown?.showItems({
			load: () => actions.map(toItem),
			refresh: loadActions && (async (token, publish) => {
				const result = await loadActions(token, choices => publish(choices.map(toItem)));
				return result?.map(toItem);
			}),
			filterItems: (items, query) => {
				if (query.trim()) { return items; }
				let recentCount = 0;
				return items.filter(entry => !entry.item?.recent || ++recentCount <= MAX_NEW_PICKER_RECENT_WORKSPACES);
			},
			select: action => action.run(),
			restoreFocusOnSelect: true,
		});
	}

	public hide(): void {
		this.dropdown?.hide();
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
			const label = recent.label && recent.label !== recent.folderUri.path && recent.label !== target.root
				? recent.label : basename(recent.folderUri) || target.root;
			return [{ label, target }];
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
