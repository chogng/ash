import { trackChatInputPickerFocus } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputPickerActionItem.js';
import { ActionWidgetDropdown } from '../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { SessionsRecentWorkspacesService } from '../../../services/sessions/browser/sessionsRecentWorkspacesService.js';
import { SessionWorkspaceFallback } from './sessionWorkspaceFallback.js';
import { projectFolders, projectForFolder, readCodeProjects } from './sessionWorkspaceProjects.js';
import { URI } from '../../../../base/common/uri.js';
import { createUuid } from '../../../../base/common/uuid.js';
import { basename, extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { observableValue } from '../../../../base/common/observable.js';
import { IWorkspacesService, type IRecentlyOpened } from '../../../../platform/workspaces/common/workspaces.js';
import { isRemoteResource } from '../../../../platform/remote/common/remote.js';
import { WorkspaceSelectionOrigin, type IWorkspaceSelectionSnapshot } from '../../../common/workspaceSelection.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
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
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IProjectService, type Project } from '../../../../platform/projects/common/projectService.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { IActionWidgetService } from '../../../../platform/actionWidget/browser/actionWidget.js';
import { ActionListItemKind, type IActionListItem, type IActionListItemInlineToggle } from '../../../../platform/actionWidget/browser/actionList.js';
import { Separator, type IAction } from '../../../../base/common/actions.js';
import { getHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import type { IChatWidgetModel } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID, type IAgentHostSessionsProvider } from '../../../common/agentHostSessionsProvider.js';
import { buildAgentHostSessionWorkspace, selectionFromResource, selectionFromWorkspace } from '../../../common/agentHostSessionWorkspace.js';
import { ISessionFolderAuthorizationService, sessionWorkspaceUri } from '../../../common/sessionWorkspace.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import type { IUntitledChatSession, SessionExecutionTarget } from '../../../services/sessions/common/session.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';

const MAX_NEW_PICKER_RECENT_WORKSPACES = 10;
const MAX_SETUP_RECENT_PROJECTS = 3;

type RecentFolder = { readonly label: string; readonly target: SessionExecutionTarget; };

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
	private selectedProject: { readonly id: string; readonly name: string; } | undefined;
	private projectRead = 0;

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
		@ISessionFolderAuthorizationService private readonly folderAuthorization: ISessionFolderAuthorizationService,
		@IProjectService private readonly projects: IProjectService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
	) {
		super();
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
				placeholder: localize({ bundle: 'ash.sessions', key: 'sessions.project.search' }, 'Search projects and folders'),
			},
		}));
		this.host = this.picker.render(container);
		this._register(sessions.onDidChange(() => this.render()));
		this._register(model.onDidChange(() => this.render()));
		this._register(workspace.onDidChangeWorkspaceFolders(() => this.render()));
		this._register(providers.onDidChangeProviders(() => this.render()));
		this._register(projects.onDidChange(() => this.readSelectedProject()));
		this._register(contextKeys.onDidChangeContext(event => {
			if (event.affectsSome(new Set([SessionsWorkspaceModeContext.key]))) {
				this.picker.hide();
				this.pending.clear();
				this.render();
			}
		}));
		this.render();
	}

	private get draft(): IUntitledChatSession | undefined {
		return this.sessions.untitledSessions.find(draft => draft.untitledSessionId === this.model.untitledSessionId);
	}

	private get isCode(): boolean { return this.contextKeys.getValue(SessionsWorkspaceModeContext.key) === 'code'; }

	private usesLocalProjects(draft: IUntitledChatSession): boolean {
		return this.isCode && (!draft.providerId || draft.providerId === LOCAL_AGENT_HOST_PROVIDER_ID);
	}

	private readSelectedProject(): void {
		const draft = this.draft;
		const generation = ++this.projectRead;
		const id = draft && this.usesLocalProjects(draft) ? draft.projectId : undefined;
		if (!id) return;
		void this.projects.read(id, 'code').then(project => {
			if (this.isDisposed || this.projectRead !== generation || this.draft?.projectId !== id) return;
			this.selectedProject = { id, name: project.name };
			this.render();
		}, () => { /* The picker can still show the selected folder during a reconnect. */ });
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
		this.presentationChanged.fire();
	}

	public renderRecentProjects(container: HTMLElement): DisposableStore {
		const lifetime = new DisposableStore();
		const rowListeners = lifetime.add(new DisposableStore());
		const document = container.ownerDocument;
		const group = h(document, 'div', {
			className: 'ash-sessions-environment-card-projects',
			attributes: { role: 'group', 'aria-label': localize({ bundle: 'ash.sessions', key: 'sessions.project.recent' }, 'Recent projects') },
		});
		container.prepend(group);
		lifetime.add(toDisposable(() => group.remove()));
		let history: readonly RecentFolder[] | undefined;
		let choices: readonly RecentFolder[] = [];
		let request = 0;
		let loading = false;
		const rows = new Map<string, { readonly button: HTMLButtonElement; readonly check: HTMLElement; }>();
		const keyFor = (target: SessionExecutionTarget) => extUriBiasedIgnorePathCase.getComparisonKey(sessionWorkspaceUri(buildAgentHostSessionWorkspace(target)!));
		const render = () => {
			const draft = this.draft;
			if (!draft || !this.isCode || !this.visible) { group.hidden = true; return; }
			if (!history && !loading) refresh();
			const source = this.workspaceSource(draft);
			const next = (history ?? []).filter(({ target }) => source
				? acceptsWorkspaceTarget(target, source) : this.usesLocalProjects(draft) && target.type === 'local').slice(0, MAX_SETUP_RECENT_PROJECTS);
			group.hidden = next.length === 0;
			if (!structuralEquals(choices, next)) {
				const focused = [...rows].find(([, row]) => row.button === document.activeElement)?.[0];
				choices = next;
				rowListeners.clear();
				rows.clear();
				group.replaceChildren();
				for (const { label, target } of choices) {
					const key = keyFor(target);
					if (rows.has(key)) continue;
					const button = h(document, 'button', {
						className: 'ash-sessions-environment-card-folder',
						attributes: { type: 'button', title: target.root },
					});
					appendIcon(Lxicon.folder, button);
					button.append(h(document, 'span', { className: 'ash-sessions-environment-card-folder-label' }, label));
					const check = appendIcon(Lxicon.check, button);
					rows.set(key, { button, check });
					rowListeners.add(addDisposableListener(button, 'click', () => {
						const current = this.draft;
						if (!current || !this.enabled || !this.visible || !this.isCode) return;
						const localProject = this.usesLocalProjects(current) && target.type === 'local';
						if (button.getAttribute('aria-pressed') === 'true' && (!localProject || current.projectId)) return;
						void this.selectWorkspace(current, 'folder', target, undefined, localProject ? () => readCodeProjects(this.projects) : undefined,
							() => { if (this.isCode && !group.hidden) rows.get(key)?.button.focus(); });
					}));
					group.append(button);
				}
				if (focused) rows.get(focused)?.button.focus();
			}
			const selected = draft.workspace.type === 'current' ? undefined : source && keyFor(source);
			for (const [key, { button, check }] of rows) {
				button.disabled = !this.enabled;
				button.setAttribute('aria-pressed', String(key === selected));
				check.hidden = key !== selected;
			}
		};
		const refresh = () => {
			const generation = ++request;
			loading = true;
			void this.picker.getRecentFolders([], () => true).then(folders => this.trustedFolders(folders)).catch(() => []).then(folders => {
				if (lifetime.isDisposed || generation !== request) return;
				loading = false;
				history = folders;
				render();
			});
		};
		lifetime.add(this.presentationChanged.event(render));
		lifetime.add(this.workspaces.onDidChangeRecentlyOpened(() => {
			if (this.visible && this.isCode && this.draft) refresh();
			else {
				request++;
				loading = false;
				history = undefined;
			}
		}));
		render();
		return lifetime;
	}

	private render(): void {
		const draft = this.draft;
		const projectId = draft && this.usesLocalProjects(draft) ? draft.projectId : undefined;
		if (this.selectedProject?.id !== projectId) {
			this.selectedProject = projectId ? { id: projectId, name: '' } : undefined;
			this.readSelectedProject();
		}
		this.host.hidden = !draft;
		const session = this.sessions.sessions.find(session => session.sessionId === this.model.sessionId);
		const selection = draft?.workspace;
		const root = selection && 'root' in selection ? selection.root : session?.workspace?.root;
		const folderName = root?.replace(/[/\\]+$/, '').split(/[/\\]/).pop()
			|| this.workspace.getWorkspace().folders.map(folder => folder.name).join(', ');
		const chooseProject = localize({ bundle: 'ash.sessions', key: 'sessions.project.choose' }, 'Choose project');
		const name = draft && this.usesLocalProjects(draft)
			? (draft.projectId && (this.selectedProject?.name || folderName)) || chooseProject
			: folderName || (this.isCode ? chooseProject : localize('sessions.workspace.select', 'Choose folder'));
		const label = draft?.devContainer || session?.workspace?.runtime?.providerId === 'ash.dev-containers'
			? localize('sessions.workspace.containerLabel', 'Dev Container · {0}', name) : name;
		this.label = label;
		const detail = root ? `${label}\n${root}` : label;
		this.tooltip = this.isCode
			? root ? localize({ bundle: 'ash.sessions', key: 'sessions.project.label' }, 'Project: {0}', detail) : label
			: localize('sessions.workspace.label', 'Folder: {0}', detail);
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
		const projectCatalog = this.usesLocalProjects(draft)
			&& (!source || source.type === 'local') ? readCodeProjects(this.projects) : undefined;
		let projectActions: IWorkspacePickerAction[] = [];
		const worktreeQuery = this.prepareWorktrees(draft, true);
		const isCurrent = (): boolean => !this.isDisposed && this.visible && this.enabled
			&& this.draft?.untitledSessionId === draft.untitledSessionId
			&& this.draft.workspace === draft.workspace && this.draft.providerId === draft.providerId
			&& this.draft.projectId === draft.projectId;
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
				if (item.mode === 'browse' || item.mode === 'clone' || item.mode === 'folder' || item.mode === 'worktree') {
					await this.selectWorkspace(draft, item.mode, item.target ?? source, undefined, projectCatalog && (() => projectCatalog));
				} else {
					this.sessions.setUntitledSessionWorkspace(draft.untitledSessionId, item.target ?? source ?? draft.workspace, {
						devContainer: item.mode === 'container',
						branchName: undefined,
					});
					status(item.label);
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
		const workspace = this.workspace.getWorkspace();
		const folders = selectionFromWorkspace(workspace);
		const workspaceFolders = folders.type === 'multiple' ? folders.folders
			: folders.type === 'current' ? [] : [{ label: workspace.folders[0]!.name, target: folders }];
		const accepts = (candidate: SessionExecutionTarget): boolean => acceptsWorkspaceTarget(candidate, source);
		const windowFolders = workspaceFolders.filter(folder => accepts(folder.target));
		let candidates: readonly RecentFolder[] = [];
		let recents: readonly RecentFolder[] = [];
		const folderUri = (target: SessionExecutionTarget): URI => sessionWorkspaceUri(buildAgentHostSessionWorkspace(target)!);
		const buildActions = () => {
			const environmentItems: IWorkspaceModeItem[] = [];
			if (hasContainer) {
				environmentItems.push({ label: localize('sessions.workspace.useHost', 'Use this host'), mode: 'workspace', picked: !draft.devContainer });
				environmentItems.push({ label: localize('sessions.workspace.useContainer', 'Use Dev Container'), mode: 'container', picked: draft.devContainer });
			}
			const worktreesOnHost = allWorktrees ?? [];
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
			// Keep the selected folder in recents even when Git lists it as a checkout.
			// Other confirmed checkouts are available under the branch submenu.
			const worktrees = new Set(sourceWorktrees.map(worktree => folderUri(worktree.target).toString()));
			const recentFolders = recents.filter(folder => {
				const key = folderUri(folder.target).toString();
				return key === sourceKey || !worktrees.has(key);
			});
			const visibleFolders = new Set([
				...candidates.map(folder => folderUri(folder.target).toString()),
				...recentFolders.map(folder => folderUri(folder.target).toString()),
			]);
			const collapsed = new Set(worktreesOnHost.flatMap(worktree => {
				if (!worktree.repository) return [];
				const checkout = folderUri(worktree.target).toString();
				const repository = folderUri(worktree.repository).toString();
				return checkout !== sourceKey && checkout !== repository && visibleFolders.has(repository) ? [checkout] : [];
			}));
			const folderActions = [
				...candidates.map(folder => folderAction(folder, false)),
				...recentFolders.filter(folder => {
					const key = folderUri(folder.target).toString();
					return !collapsed.has(key);
				}).map(folder => folderAction(folder, true)),
			];
			return Separator.join(
				projectActions,
				[...folderActions, ...environmentItems.map(toAction)],
				[...actions, openFolder],
				worktreeActions,
			);
		};
		this.picker.showPicker(buildActions(), async (token, publish) => {
			const update = () => {
				if (!token.isCancellationRequested && isCurrent()) publish(buildActions());
			};
			const provider = this.providers.getProvider(draft.providerId ?? '') as IAgentHostSessionsProvider | undefined;
			await Promise.all([
				projectCatalog?.then(projects => {
					projectActions = projects.filter(project => !project.archived).map(project => {
						const folders = projectFolders(project);
						const chooseFolder = (folder: URI): IWorkspacePickerAction => ({
							id: `sessions.project.${project.id}.${folder.toString()}`,
							label: basename(folder) || folder.fsPath, tooltip: folder.fsPath, rowTooltip: folder.fsPath,
							enabled: true, icon: Lxicon.folder,
							run: () => { if (isCurrent()) return this.selectWorkspace(draft, 'folder', selectionFromResource(folder), project.id); },
						});
						return {
							id: `sessions.project.${project.id}`, label: project.name, icon: Lxicon.projects,
							tooltip: folders.length === 1 ? folders[0]!.fsPath : project.name, enabled: true,
							checked: draft.projectId === project.id,
							submenu: folders.length > 1 ? folders.map(chooseFolder) : undefined,
							run: () => {
								if (!isCurrent()) return;
								if (folders.length === 1) return chooseFolder(folders[0]!).run();
								if (!folders.length) return this.selectWorkspace(draft, 'browse', source, project.id);
							},
						};
					});
					update();
				}, () => { /* Folder and worktree choices can load independently of the project catalog. */ }),
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
				this.trustedFolders(windowFolders).then(result => {
					candidates = result;
					if (candidates.length) update();
				}),
				this.picker.getRecentFolders(windowFolders, accepts).catch(() => []).then(async history => {
					if (token.isCancellationRequested || !isCurrent()) return;
					const known = new Set([...windowFolders, ...history].map(({ target }) => folderUri(target).toString()));
					const sessionFolders = this.workspaceFallback.getWorkspaces(draft.providerId, known, accepts);
					recents = await this.trustedFolders([...history, ...sessionFolders]);
					if (recents.length) update();
				}),
			]);
		});
	}

	private async trustedFolders(folders: readonly RecentFolder[]): Promise<readonly RecentFolder[]> {
		const trusted = await Promise.all(folders.map(({ target }) => target.type !== 'local'
			|| this.folderAuthorization.isTrusted(target.root).catch(() => false)));
		return folders.filter((_, index) => trusted[index]);
	}

	private async selectWorkspace(draft: IUntitledChatSession, mode: 'browse' | 'clone' | 'folder' | 'worktree', source: SessionExecutionTarget | undefined, projectId?: string, projectCatalog?: () => Promise<readonly Project[]>, restoreFocus = () => this.picker.focus()): Promise<void> {
		const lifetime = new DisposableStore();
		this.pending.value = lifetime;
		this.pendingDraftId = draft.untitledSessionId;
		const cancellation = new CancellationTokenSource();
		const authorization = new AbortController();
		lifetime.add(toDisposable(() => authorization.abort()));
		lifetime.add(toDisposable(() => cancellation.dispose(true)));
		lifetime.add(toDisposable(() => {
			this.pendingDraftId = undefined;
			if (!this.isDisposed && this.enabled && this.visible) { restoreFocus(); }
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
			} else if (mode === 'browse') {
				if (source && source.type !== 'local') {
					const root = await this.quickInput.input({
						title: localize('sessions.workspace.browseTitle', 'Choose a folder'),
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
						title: localize('sessions.workspace.browseTitle', 'Choose a folder'),
						canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri,
					});
					if (!folders?.[0]) { return; }
					target = selectionFromResource(folders[0]);
				}
			}
			// Native dialogs may outlive their composer; a late result must not change another draft.
			const isCurrent = () => !authorization.signal.aborted && this.draft?.untitledSessionId === draft.untitledSessionId
				&& this.draft.workspace === draft.workspace && this.draft.providerId === draft.providerId
				&& this.draft.projectId === draft.projectId && this.model.inputState.phase !== 'submitting';
			if (!target || !isCurrent()) { return; }
			const provider = draft.providerId && this.providers.getProvider(draft.providerId) as IAgentHostSessionsProvider | undefined;
			const accepted = provider && provider.authorizeWorkspace
				? await provider.authorizeWorkspace(target, authorization.signal)
				: target.type !== 'local' || await this.folderAuthorization.authorize(target.root, authorization.signal);
			if (!accepted || !isCurrent()) { return; }
			let project: Project | undefined;
			if (projectId) {
				project = await this.projects.read(projectId, 'code');
				if (!isCurrent()) return;
				const resource = URI.file(target.root);
				const belongs = projectFolders(project).some(folder => extUriBiasedIgnorePathCase.isEqual(folder, resource));
				if (project.archived || (!belongs && mode !== 'browse')) {
					throw new Error(localize({ bundle: 'ash.sessions', key: 'sessions.project.unavailable' }, 'This project is unavailable. Choose another project.'));
				}
				if (!belongs) {
					project = await this.projects.update(project, project.name, project.description, [
						...project.materials, { kind: 'folder', name: basename(resource) || target.root, resource },
					]);
				}
			} else if (!projectId && projectCatalog && target.type === 'local' && (mode !== 'worktree' || !draft.projectId)) {
				const checkoutSource = mode === 'worktree' ? this.workspaceSource(draft) : undefined;
				const resource = URI.file(checkoutSource?.type === 'local' ? checkoutSource.root : target.root);
				const projects = await projectCatalog();
				if (!isCurrent()) return;
				project = await projectForFolder(this.projects, projects, resource);
			}
			if (!isCurrent()) return;
			this.sessions.setUntitledSessionWorkspace(draft.untitledSessionId, target, mode === 'worktree'
				? { devContainer: this.draft?.devContainer, branchName: this.draft?.branchName, projectId: draft.projectId ?? project?.id }
				: { projectId: projectId ?? project?.id });
			status(this.isCode ? localize({ bundle: 'ash.sessions', key: 'sessions.project.folderSelected' }, 'Project folder: {0}', target.root)
				: localize('sessions.workspace.selected', 'Conversation folder: {0}', target.root));
			if (mode !== 'worktree') await this.recordRecentFolder(draft.providerId, target);
		} catch (error) {
			if (!cancellation.token.isCancellationRequested && !isCancellationError(error)) { this.notifications.error(getErrorMessage(error)); }
		} finally {
			if (this.pending.value === lifetime) { this.pending.clear(); }
		}
	}

	private async recordRecentFolder(providerId: string | undefined, target: SessionExecutionTarget): Promise<void> {
		if (providerId) this.recentWorkspaces.setSelected(providerId, target);
		const folderUri = sessionWorkspaceUri(buildAgentHostSessionWorkspace(target)!);
		const label = target.root.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || target.root;
		await this.workspaces.addRecentlyOpened([{ folderUri, label }]);
	}

}

function acceptsWorkspaceTarget(candidate: SessionExecutionTarget, source: SessionExecutionTarget | undefined): boolean {
	if (source?.type === 'ssh') return candidate.type === 'ssh' && candidate.host === source.host;
	if (source?.type === 'remote') return candidate.type === 'remote' && candidate.authority === source.authority;
	return candidate.type === 'local';
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

	private readonly renderDisposables = this._register(new DisposableStore());
	private dropdown: ActionWidgetDropdown | undefined;

	constructor(
		private readonly options: { readonly trigger?: { readonly actionWidget: IActionWidgetService; readonly action: IAction; readonly onDidChange: Event<void>; readonly placeholder: string; }; },
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IWorkspacesService private readonly workspaces: IWorkspacesService,
		@INotificationService private readonly notifications: INotificationService,
	) { super(); }

	public render(container: HTMLElement): HTMLElement {
		this.renderDisposables.clear();
		const trigger = this.options.trigger!;
		const slot = h(container.ownerDocument, 'div', { className: 'ash-sessions-chat-input-workspace' });
		container.prepend(slot);
		const dropdown = this.dropdown = this.renderDisposables.add(new ActionWidgetDropdown(slot, {
			label: trigger.action.label, ariaLabel: trigger.action.tooltip,
			buttonOptions: { icon: trigger.action.icon, presentation: 'quiet', size: 'small' },
			onOpen: () => { trigger.action.run(); },
			tabLeavesPopup: true,
			onError: error => this.reportError(error),
			listOptions: {
				className: 'ash-action-widget-accent-checks',
				menuIconPlacement: 'leading-with-trailing-check',
				showRowTooltips: true,
				showFilter: true,
				focusFilterOnOpen: true,
				filterPlaceholder: trigger.placeholder,
				ariaLabel: trigger.placeholder,
			},
		}, trigger.actionWidget));
		dropdown.element.classList.add('ash-sessions-workspace-picker');
		this.renderDisposables.add(trackChatInputPickerFocus(slot));
		const hover = this.renderDisposables.add(getHoverDelegate().setupHover({ target: dropdown.element, content: trigger.action.tooltip }));
		const update = (): void => {
			dropdown.setLabel(trigger.action.label);
			dropdown.setEnabled(trigger.action.enabled);
			dropdown.element.tabIndex = trigger.action.enabled ? 0 : -1;
			dropdown.element.setAttribute('aria-label', trigger.action.tooltip);
			hover.update(trigger.action.tooltip);
		};
		this.renderDisposables.add(trigger.onDidChange(update));
		this.renderDisposables.add(toDisposable(() => {
			this.dropdown = undefined;
			slot.remove();
		}));
		update();
		return slot;
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
