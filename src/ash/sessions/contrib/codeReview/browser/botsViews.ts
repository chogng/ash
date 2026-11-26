import { addDisposableListener, Dimension, getWindow, h, type IDimension } from '../../../../base/browser/dom.js';
import { isAncestorOfActiveElement } from '../../../../base/browser/focus.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { ObjectTreeElementCollapseState } from '../../../../base/browser/ui/tree/tree.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationTokenSource, throwIfCancelled, type CancellationToken } from '../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { autorun, observableSignalFromEvent, observableValue, type IReader } from '../../../../base/common/observable.js';
import { posix } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import type { AgentRoleDefinition } from '../../../../platform/agentHost/common/agent.js';
import { AppServerRemoteError } from '../../../../platform/agentHost/common/appServerError.js';
import { AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService, createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { ViewPane, ViewPaneShowActions, type IViewPaneOptions } from '../../../../workbench/browser/parts/views/viewPane.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../../workbench/contrib/sessions/common/agentHostSessionsProvider.js';
import { CONFIGURE_ADVISOR_COMMAND_ID } from '../../../../workbench/contrib/advisor/browser/advisor.js';
import type { ChatMessagePresentation } from '../../../../workbench/contrib/chat/browser/chat.js';
import { chatTranscriptListItems } from '../../../../workbench/contrib/chat/common/model/chatViewModel.js';
import { IChatService, type ChatAgent, type ThreadRead } from '../../../../workbench/services/chat/common/chatService.js';
import type { IActiveSessionThread } from '../../../../workbench/services/sessions/common/session.js';
import { ISessionProviderScopeService } from '../../../browser/agentHost/sessionProviderScopeService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { NewChatView } from '../../chat/browser/chatView.js';
import { SessionCodeReviewEditor } from './sessionCodeReviewEditor.js';
import { codeReviewRequestPrefix, codeReviewResource, ISessionCodeReviewService, type CodeReviewTarget, type SessionCodeReviewService } from './sessionCodeReviewService.js';
import { createUserBotLabel, editUserBotLabel, showUserBotDialog } from './userBotDialog.js';
import './media/bots.css';

export const botsNavigationId = 'sessions.navigation.bots';
export const botsResource = URI.from({ scheme: 'ash-bots', path: '/page' });
export const botsFocusContext = 'sessionsBotsFocused';

const botsTitle = localize('sessions.bots.title', 'Bots');
const reviewName = localize('sessions.codeReview.title', 'Code Review');
const reviewGroupId = 'codeReview';
const advisorName = localize('sessions.bots.advisor', 'Advisor');
const issueName = localize('sessions.bots.issue', 'Issue');
const workspaceBotsName = localize('sessions.bots.workspace', 'Workspace Bots');
const userBotsName = localize('sessions.bots.userBots', 'My Bots');
const issueDescription = localize('sessions.bots.issueDescription', 'Choose a repository and enter a GitHub issue. This agent requires the GitHub skill and a connection to the official GitHub MCP server.');

const botNames = { [reviewGroupId]: reviewName, advisor: advisorName, issue: issueName, workspace: workspaceBotsName, user: userBotsName };
type BuiltInBotId = keyof typeof botNames;
type BotId = BuiltInBotId | `user:${string}`;
const botIds: readonly BuiltInBotId[] = [reviewGroupId, 'advisor', 'issue', 'workspace', 'user'];
const userBotId = (name: string): `user:${string}` => `user:${name}`;
const userConversationKey = (name: string) => `sessions.bots.lastConversation.${name}`;

export const IBotsViewState = createServiceIdentifier<BotsViewState>('botsViewState');

export class BotsViewState {
	readonly activeBot = observableValue<BotId>(this, reviewGroupId);
	readonly userBots = observableValue<readonly AgentRoleDefinition[]>(this, []);
}

type BotTreeItem =
	| { readonly kind: 'bot'; readonly id: BotId; readonly label: string; }
	| { readonly kind: 'thread'; readonly id: string; readonly label: string; readonly detail: string; readonly target: CodeReviewTarget; };

function reviewThreadNodeId(sessionId: string, threadId: string): string {
	return JSON.stringify([sessionId, threadId]);
}

function bindAccessibility(
	root: HTMLElement, owner: DisposableStore, contexts: IContextKeyService,
	accessibleViews: IAccessibleViewService, configuration: IConfigurationService,
): void {
	owner.add(contexts.createScoped(root)).createKey(botsFocusContext, true);
	const update = () => {
		const hint = accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.Bots);
		if (hint) root.setAttribute('aria-description', hint);
		else root.removeAttribute('aria-description');
	};
	owner.add(configuration.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration(AccessibilityVerbositySettingId.Bots)) update();
	}));
	update();
}

export class BotsNavigationView extends ViewPane {
	private readonly toolbar: WorkbenchToolBar;

	constructor(
		parent: HTMLElement, options: IViewPaneOptions,
		@ISessionCodeReviewService reviews: SessionCodeReviewService,
		@IBotsViewState bots: BotsViewState,
		@ICommandService commands: ICommandService,
		@INotificationService notifications: INotificationService,
		@IContextKeyService contexts: IContextKeyService,
		@IAccessibleViewService accessibleViews: IAccessibleViewService,
		@IConfigurationService configuration: IConfigurationService,
		@IContextMenuService contextMenus: IContextMenuService,
	) {
		super(parent, { ...options, showActions: ViewPaneShowActions.Always });
		const root = this.contentElement;
		const document = root.ownerDocument;
		root.classList.add('ash-bots-sidebar');
		root.setAttribute('role', 'region');
		root.setAttribute('aria-label', botsTitle);
		bindAccessibility(root, this._store, contexts, accessibleViews, configuration);
		// The sidebar projects title actions outside the view body.
		this._register(contexts.createScoped(this.headerActionsElement)).createKey(botsFocusContext, true);
		this.toolbar = this._register(new WorkbenchToolBar(this.headerActionsElement, contextMenus, { ariaLabel: botsTitle }));
		const back = localize({ bundle: 'ash', key: 'sessions.navigation.back' }, 'Back');
		this.toolbar.setActions([{
			id: 'sessions.open.code',
			label: back,
			tooltip: back,
			icon: Lxicon.arrowLeft,
			enabled: true,
			run: () => commands.executeCommand('sessions.open.code').catch(error => notifications.error(error)),
		}]);
		const search = this._register(new InputBox(root, {
			inputBoxStyles: defaultInputBoxStyles,
			ariaLabel: localize('sessions.bots.search', 'Search Bots and Threads'),
			type: 'search',
			presentation: 'field',
			leadingIcon: Lxicon.search,
			placeholder: localize('sessions.bots.searchPlaceholder', 'Search'),
		}));
		const tree = this._register(new WorkbenchObjectTree<BotTreeItem>(root, {
			configurationService: configuration,
			ariaLabel: botsTitle,
			scrolling: 'external',
			multipleSelectionSupport: false,
			expandOnlyOnTwistieClick: false,
			expandOnDoubleClick: false,
			modelOptions: { identityProvider: { getId: item => item.id } },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: item => item.label },
			accessibilityProvider: {
				getAriaLabel: item => item.kind === 'thread' && item.detail ? `${item.label}, ${item.detail}` : item.label,
			},
			getHeight: item => item.kind === 'bot' ? 36 : 40,
			renderElement: item => {
				const label = h(document, 'span', { className: 'ash-bots-tree-label' }, item.label);
				if (item.kind === 'bot') {
					const avatar = h(document, 'span', { className: 'ash-bots-avatar', attributes: { 'aria-hidden': 'true' } });
					return h(document, 'span', { className: 'ash-bots-tree-group' }, avatar, label);
				}
				const detail = h(document, 'span', { className: 'ash-bots-thread-detail', attributes: { 'aria-hidden': 'true' } }, item.detail);
				return h(document, 'span', { className: 'ash-bots-tree-thread' }, label, detail);
			},
		}));
		tree.domNode.classList.add('ash-bots-tree');
		const empty = h(document, 'p', { className: 'ash-bots-empty', attributes: { role: 'status' } });
		root.append(empty);

		const searchChanged = observableSignalFromEvent(this, search.onDidChange);
		// Searching reveals matches without replacing the unfiltered tree's collapse state.
		let collapseBeforeSearch: boolean | undefined;
		const clearSearchAfterToggle = (collapsed: boolean): void => {
			if (collapseBeforeSearch === undefined) return;
			collapseBeforeSearch = collapsed;
			search.value = '';
		};
		const syncSelection = (entry: ReturnType<typeof reviews.activeEntry.get>): void => {
			// Focus can move through the tree before the user opens a conversation.
			const active = bots.activeBot.get();
			const thread = active === reviewGroupId && entry && !tree.isCollapsed(reviewGroupId)
				? reviewThreadNodeId(entry.session.sessionId, entry.threadId) : undefined;
			const selected = thread && tree.isCollapsed(thread) !== undefined ? thread : active;
			tree.setSelection(tree.isCollapsed(selected) === undefined ? [] : [selected]);
		};
		const open = (item: BotTreeItem): void => {
			if (item.kind === 'thread') reviews.select(item.target);
			bots.activeBot.set(item.kind === 'bot' ? item.id : reviewGroupId, undefined);
		};
		this._register(tree.onDidChangeCollapseState(({ browserEvent, collapsed, element }) => {
			if (browserEvent && element.id === reviewGroupId) clearSearchAfterToggle(collapsed);
			syncSelection(reviews.activeEntry.get());
		}));
		this._register(tree.onDidAccept(({ element, node }) => {
			open(element);
			if (element.kind === 'bot' && node.collapsible) {
				const collapsed = !node.collapsed;
				tree.toggleCollapsed(element.id);
				if (element.id === reviewGroupId) clearSearchAfterToggle(collapsed);
			}
		}));
		this._register(tree.onPointer(({ element, browserEvent }) => {
			if (browserEvent.button === 0) open(element);
		}));
		this._register(tree.onDidChangeSelection(({ browserEvent }) => {
			if (browserEvent) syncSelection(reviews.activeEntry.get());
		}));
		this._register(search.onKeyDown(event => {
			if (event.key === 'Escape' && !event.isComposing && search.value) {
				event.preventDefault();
				event.stopPropagation();
				search.value = '';
			}
		}));
		this._register(autorun(reader => {
			searchChanged.read(reader);
			const query = search.value.trim().toLocaleLowerCase();
			const matchingBot = reviewName.toLocaleLowerCase().includes(query);
			const entries = reviews.entries.read(reader).filter(entry => matchingBot
				|| [entry.label, entry.detail].some(value => value.toLocaleLowerCase().includes(query)));
			const currentCollapse = tree.isCollapsed(reviewGroupId) ?? false;
			if (query) collapseBeforeSearch ??= currentCollapse;
			const collapsed = !query && (collapseBeforeSearch ?? currentCollapse)
				? ObjectTreeElementCollapseState.Collapsed : ObjectTreeElementCollapseState.Expanded;
			if (!query) collapseBeforeSearch = undefined;
			const children = entries.map(entry => ({
				element: {
					kind: 'thread', id: reviewThreadNodeId(entry.session.sessionId, entry.threadId), label: entry.label, detail: entry.detail,
					target: { sessionId: entry.session.sessionId, threadId: entry.threadId },
				} satisfies BotTreeItem,
			}));
			const personalBots = bots.userBots.read(reader).filter(role => role.name.includes(query) || role.description.toLocaleLowerCase().includes(query))
				.map(role => ({ element: { kind: 'bot', id: userBotId(role.name), label: role.name } satisfies BotTreeItem }));
			const groups = botIds.flatMap(id => {
				const element: BotTreeItem = { kind: 'bot', id, label: botNames[id] };
				if (id === reviewGroupId) return matchingBot || children.length ? [{ element, collapsed, children }] : [];
				if (id === 'user') return botNames[id].toLocaleLowerCase().includes(query) || personalBots.length
					? [{ element, collapsed: query ? ObjectTreeElementCollapseState.Expanded : false, children: personalBots }] : [];
				return botNames[id].toLocaleLowerCase().includes(query) ? [{ element }] : [];
			});
			const active = bots.activeBot.read(reader);
			tree.domNode.hidden = !groups.length;
			tree.setChildren(groups);
			if (!tree.focus && groups.length) tree.setFocus(tree.isCollapsed(active) !== undefined ? active : groups[0]!.element.id);
			syncSelection(reviews.activeEntry.read(reader));
			const noReviewThreads = active === reviewGroupId && matchingBot && children.length === 0;
			empty.hidden = groups.length > 0 && !noReviewThreads;
			empty.textContent = noReviewThreads ? localize('sessions.bots.noThreads', 'No review threads yet.')
				: localize('sessions.bots.noMatches', 'No matching bots or threads.');
		}));
	}

	public override focus(): void { this.toolbar.focus(); }

	public getAccessibleContent(): string { return this.contentElement.innerText; }
}

/** The Bots page mounts the existing chat and comparison in independent regions. */
export class BotsEditor extends EditorPane {
	static readonly ID = 'sessions.editor.bots';
	readonly id = BotsEditor.ID;
	private readonly chat = this._register(new MutableDisposable<NewChatView>());
	private readonly comparison = this._register(new MutableDisposable<DisposableStore>());
	private readonly comparisonLoad = this._register(new MutableDisposable());
	private readonly advisorHistory = this._register(new MutableDisposable<DisposableStore>());
	private readonly pendingAction = this._register(new MutableDisposable());
	private readonly busy = observableValue(this, false);
	private readonly visible = observableValue(this, false);
	private comparisonEditor: SessionCodeReviewEditor | undefined;
	private returnFocus: HTMLElement | undefined;
	private root!: HTMLElement;
	private conversation!: HTMLElement;
	private detail!: HTMLElement;
	private comparisonHost!: HTMLElement;
	private comparisonError!: HTMLElement;
	private closeButton!: Button;
	private chatKey: string | undefined;
	private userCatalogRevision = 0;

	constructor(
		@ISessionCodeReviewService private readonly reviews: SessionCodeReviewService,
		@IBotsViewState private readonly bots: BotsViewState,
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@ISessionsService private readonly sessionViews: ISessionsService,
		@IChatService private readonly chatService: IChatService,
		@ISessionProviderScopeService private readonly scopes: ISessionProviderScopeService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IDialogService private readonly dialogs: IDialogService,
		@ICommandService private readonly commands: ICommandService,
		@INotificationService private readonly notifications: INotificationService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextKeyService private readonly contexts: IContextKeyService,
		@IAccessibleViewService private readonly accessibleViews: IAccessibleViewService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IThemeService theme: IThemeService,
		@IStorageService private readonly storage: IStorageService,
	) { super(BotsEditor.ID, theme, storage); }

	public override create(parent: HTMLElement): void {
		const document = parent.ownerDocument;
		this.root = h(document, 'section', {
			className: 'ash-bots-page', properties: { tabIndex: -1 }, attributes: { 'aria-label': botsTitle },
		});
		parent.append(this.root);
		super.create(this.root);
		this._register(toDisposable(() => this.root.remove()));
		bindAccessibility(this.root, this._store, this.contexts, this.accessibleViews, this.configuration);

		const avatar = h(document, 'span', { className: 'ash-bots-avatar', attributes: { 'aria-hidden': 'true' } });
		const title = h(document, 'h1', reviewName);
		const context = h(document, 'p', reviewName);
		const header = h(document, 'header', { className: 'ash-bots-header' }, avatar, h(document, 'div', { className: 'ash-bots-heading' }, title, context));
		const review = this._register(new Button(header, {
			...defaultButtonStyles, label: localize('sessions.codeReview.reviewChanges', 'Review Changes'),
			icon: Lxicon.codeReview, presentation: 'secondary',
			onClick: () => {
				const active = this.activeCodeThread();
				if (!active) return;
				void this.openComparison(codeReviewResource({ sessionId: active.session.sessionId, threadId: active.threadId }), review.domNode);
			},
		}));
		const findIssues = this._register(new Button(header, {
			...defaultButtonStyles, label: localize('sessions.bots.findIssues', 'Find Issues'), presentation: 'secondary',
			onClick: () => this.runAction(reviewGroupId, (isCurrent, token) => this.runReviewer(isCurrent, token)),
		}));
		const configure = this._register(new Button(header, {
			...defaultButtonStyles, label: localize('sessions.bots.configureAdvisor', 'Configure Advisor'), presentation: 'secondary',
			onClick: () => void this.commands.executeCommand(CONFIGURE_ADVISOR_COMMAND_ID).catch(error => this.notifications.error(error)),
		}));
		const ask = this._register(new Button(header, {
			...defaultButtonStyles, label: localize('sessions.bots.askAdvisor', 'Ask Advisor'), presentation: 'primary',
			onClick: () => this.runAction('advisor', (isCurrent, token) => this.askAdvisor(isCurrent, token)),
		}));
		const startIssue = this._register(new Button(header, {
			...defaultButtonStyles, label: localize('sessions.bots.startIssue', 'Start Issue Task'), presentation: 'primary',
			onClick: () => this.runAction('issue', isCurrent => this.openTask({ builtIn: true, name: 'issue', description: issueDescription }, isCurrent)),
		}));
		const chooseRole = this._register(new Button(header, {
			...defaultButtonStyles, label: localize('sessions.bots.chooseRole', 'Choose Agent'), presentation: 'primary',
			onClick: () => this.runAction('workspace', (isCurrent, token) => this.openWorkspaceTask(isCurrent, token)),
		}));
		const createBot = this._register(new Button(header, {
			...defaultButtonStyles, label: createUserBotLabel, presentation: 'secondary',
			onClick: () => this.runAction(this.bots.activeBot.get(), (isCurrent, token) => this.saveUserBot(createBot, isCurrent, token)),
		}));
		const editBot = this._register(new Button(header, {
			...defaultButtonStyles, label: editUserBotLabel, presentation: 'secondary',
			onClick: () => this.editUserBot(editBot),
		}));
		const deleteBot = this._register(new Button(header, {
			...defaultButtonStyles, label: localize('sessions.bots.deleteUserBot', 'Delete Bot'), presentation: 'secondary',
			onClick: () => this.deleteUserBot(deleteBot, createBot),
		}));
		const newUserConversation = this._register(new Button(header, {
			...defaultButtonStyles, label: localize('sessions.bots.newUserBotConversation', 'New Conversation'), presentation: 'primary',
			onClick: () => this.openUserBotConversation(),
		}));
		const empty = h(document, 'p', { className: 'ash-bots-welcome' });
		const advisorResults = h(document, 'section', {
			className: 'ash-bots-advisor-results', properties: { tabIndex: 0 },
			attributes: { 'aria-label': localize('sessions.bots.advisorHistory', 'Advisor history') },
		});
		this.conversation = h(document, 'div', { className: 'ash-bots-conversation ash-chat-content-layout' }, empty, advisorResults);
		const detailHeader = h(document, 'header', { className: 'ash-bots-detail-header' }, h(document, 'h2', localize('sessions.bots.comparison', 'Comparison')));
		this.closeButton = this._register(new Button(detailHeader, {
			...defaultButtonStyles, label: localize('sessions.bots.closeComparison', 'Close Comparison'),
			icon: Lxicon.close, iconOnly: true, presentation: 'quiet',
			onClick: () => this.closeComparison(true),
		}));
		this.comparisonHost = h(document, 'div', { className: 'ash-bots-comparison' });
		this.comparisonError = h(document, 'p', {
			className: 'ash-bots-comparison-error', properties: { hidden: true }, attributes: { role: 'status' },
		});
		this.detail = h(document, 'section', {
			className: 'ash-bots-detail', properties: { hidden: true },
			attributes: { 'aria-label': localize('sessions.bots.comparison', 'Comparison') },
		}, detailHeader, this.comparisonError, this.comparisonHost);
		this.root.append(header, h(document, 'div', { className: 'ash-bots-body' }, this.conversation, this.detail));
		this._register(addDisposableListener(this.detail, 'keydown', event => {
			if (event.key === 'Escape' && !event.defaultPrevented) {
				event.preventDefault();
				event.stopPropagation();
				this.closeComparison(true);
			}
		}));

		const sessionsChanged = observableSignalFromEvent(this, this.sessions.onDidChange);
		const configurationChanged = observableSignalFromEvent(this, this.configuration.onDidChangeConfiguration);
		const recentUserChatChanged = observableSignalFromEvent(this, this.storage.onDidChangeValue);
		let previousBot = this.bots.activeBot.get();
		this._register(autorun(reader => {
			sessionsChanged.read(reader);
			configurationChanged.read(reader);
			recentUserChatChanged.read(reader);
			const bot = this.bots.activeBot.read(reader);
			const userBot = this.bots.userBots.read(reader).find(role => userBotId(role.name) === bot);
			const personal = userBot && this.userConversation(userBot.name);
			if (bot !== previousBot) {
				previousBot = bot;
				this.clearPendingAction();
			}
			const active = this.activeCodeThread();
			const entry = bot === reviewGroupId ? this.reviews.activeEntry.read(reader) : undefined;
			const busy = this.busy.read(reader);
			const aiEnabled = !this.configuration.getValue<boolean>(ChatAIDisabledSettingId);
			const canRun = !busy && aiEnabled;
			review.domNode.hidden = findIssues.domNode.hidden = bot !== reviewGroupId;
			ask.domNode.hidden = configure.domNode.hidden = bot !== 'advisor';
			startIssue.domNode.hidden = bot !== 'issue';
			chooseRole.domNode.hidden = bot !== 'workspace';
			createBot.domNode.hidden = bot !== 'user' && !userBot;
			editBot.domNode.hidden = !userBot;
			deleteBot.domNode.hidden = !userBot;
			newUserConversation.domNode.hidden = !userBot;
			createBot.enabled = editBot.enabled = deleteBot.enabled = newUserConversation.enabled = canRun;
			review.enabled = !!active;
			findIssues.enabled = !!active && canRun;
			ask.enabled = !!active && canRun;
			configure.enabled = aiEnabled && !busy;
			startIssue.enabled = chooseRole.enabled = canRun;
			advisorResults.hidden = bot !== 'advisor' || !active;
			empty.hidden = !!entry || !!userBot || !advisorResults.hidden;
			switch (bot) {
				case 'advisor': empty.textContent = localize('sessions.bots.selectAdvisorConversation', 'Open a Code conversation to ask Advisor for a second opinion.'); break;
				case 'issue': empty.textContent = issueDescription; break;
				case 'workspace': empty.textContent = localize('sessions.bots.workspaceDescription', 'Start a task with an agent defined by this workspace.'); break;
				case 'user': empty.textContent = localize('sessions.bots.userBotsDescription', 'Choose a Bot or create your own.'); break;
				case reviewGroupId: empty.textContent = active
					? localize('sessions.bots.startReview', 'Choose Review Changes to start a thread with Code Review.')
					: localize('sessions.codeReview.selectConversation', 'Open a conversation with code changes to start a review.'); break;
				default: empty.textContent = ''; break;
			}
			title.textContent = entry?.label ?? userBot?.name ?? (botNames[bot as BuiltInBotId] || userBotsName);
			const sourceTitle = active?.session.chats.find(chat => chat.threadId === active.threadId)?.title ?? active?.session.title;
			context.textContent = entry ? localize('sessions.bots.threadContext', 'Code Review · {0}', entry.detail) : bot === 'advisor' ? sourceTitle ?? '' : userBot?.description ?? '';
			const conversation = entry ? { session: entry.session, threadId: entry.threadId } : personal;
			const key = conversation ? JSON.stringify([bot, conversation.session.sessionId, conversation.threadId]) : bot;
			if (key === this.chatKey) return;
			this.chatKey = key;
			if (this.chat.value) this.chat.value.setVisible(false);
			this.chat.clear();
			this.closeComparison(false);
			if (!conversation) return;
			const target = { sessionId: conversation.session.sessionId, threadId: conversation.threadId };
			this.chat.value = this.instantiation.createInstance(NewChatView, this.conversation, {
				panelId: 'ash-bots-chat',
				selection: {
					kind: 'session', active: conversation,
					firstRequestClientId: entry?.firstRequestClientId,
				},
				createNewSession: () => { if (userBot) this.openUserBotConversation(); else if (review.enabled) review.domNode.click(); },
				onDidChangeInfo: () => { },
				messagePresentation: userBot ? { assistant: { name: userBot.name } } : this.messagePresentation(target),
			});
			this.chat.value.setVisible(this.isVisible());
		}));
		let advisorSource: string | undefined;
		this._register(autorun(reader => {
			sessionsChanged.read(reader);
			const active = this.visible.read(reader) && this.bots.activeBot.read(reader) === 'advisor' ? this.activeCodeThread() : undefined;
			const key = active && JSON.stringify([active.session.sessionId, active.threadId]);
			if (advisorSource === key) return;
			advisorSource = key;
			this.advisorHistory.clear();
			advisorResults.replaceChildren();
			if (active) this.bindAdvisorHistory(advisorResults, active);
		}));
		const markViewed = () => this.markThreadViewed();
		this._register(this.onDidFocus(markViewed));
		this._register(addDisposableListener(getWindow(document), 'focus', markViewed));
		this._register(addDisposableListener(document, 'visibilitychange', markViewed));
		this._register(autorun(reader => this.markThreadViewed(reader)));
	}

	private activeCodeThread(): IActiveSessionThread | undefined {
		if (this.sessions.activeUntitledSession) return undefined;
		const active = this.sessions.active;
		if (active?.session.kind === 'code' && active.session.status === 'active'
			&& active.session.chats.some(chat => chat.threadId === active.threadId && chat.status === 'active')) return active;
		return undefined;
	}

	private userConversation(name: string): IActiveSessionThread | undefined {
		const id = this.storage.get(userConversationKey(name), StorageScope.PROFILE);
		if (!id) return undefined;
		const session = this.sessions.sessions.find(candidate => candidate.sessionId === id && candidate.status === 'active');
		return session?.chats.some(chat => chat.threadId === id && chat.status === 'active') ? { session, threadId: id } : undefined;
	}

	private async refreshUserBots(): Promise<void> {
		const revision = ++this.userCatalogRevision;
		const scope = this.scopes.getProviderScope(LOCAL_AGENT_HOST_PROVIDER_ID);
		const catalog = await scope.services.host.session.readRoleCatalog();
		if (revision !== this.userCatalogRevision || !this.isVisible()) return;
		scope.assertCurrent();
		this.bots.userBots.set(catalog.agents.filter(role => role.source.type === 'user'), undefined);
	}

	private async editUserBot(trigger: Button): Promise<void> {
		const selected = this.bots.activeBot.get();
		await this.runAction(selected, async (isCurrent, token) => {
			await this.refreshUserBots();
			if (!isCurrent()) return;
			const role = this.bots.userBots.get().find(bot => userBotId(bot.name) === selected);
			if (!role) throw new Error(localize('sessions.bots.userBotMissing', 'This Bot is no longer available.'));
			await this.saveUserBot(trigger, isCurrent, token, role);
		});
		if (this.isVisible() && this.bots.activeBot.get() === selected && !trigger.domNode.hidden) trigger.focus();
	}

	private async deleteUserBot(trigger: Button, createButton: Button): Promise<void> {
		const selected = this.bots.activeBot.get();
		let removed = false;
		await this.runAction(selected, async isCurrent => {
			await this.refreshUserBots();
			if (!isCurrent()) return;
			const role = this.bots.userBots.get().find(bot => userBotId(bot.name) === selected);
			if (!role) throw new Error(localize('sessions.bots.userBotMissing', 'This Bot is no longer available.'));
			const confirmation = await this.dialogs.confirm({
				message: localize('sessions.bots.deleteUserBotConfirm', 'Delete Bot "{0}"?', role.name),
				detail: localize('sessions.bots.deleteUserBotDetail', 'This removes the Bot from its projects. Ash takes over wherever this Bot was the default. Existing conversations stay in Code.'),
				primaryButton: localize('sessions.bots.deleteUserBot', 'Delete Bot'), destructive: true,
			});
			if (!confirmation.confirmed || !isCurrent()) return;
			const scope = this.scopes.getProviderScope(LOCAL_AGENT_HOST_PROVIDER_ID);
			const { session } = scope.services.host;
			if (!session.deleteUserRole) throw new Error(localize('sessions.bots.userBotDeleteUnavailable', 'This Agent host cannot delete personal Bots.'));
			scope.assertCurrent();
			try {
				await session.deleteUserRole({
					name: role.name, expectedContentDigest: role.contentDigest,
					coordinatorResponsibility: localize('sessions.projectBots.ashResponsibility', 'Handle new project tasks.')
				});
			} catch (error) {
				if (error instanceof AppServerRemoteError && error.errorName === 'RevisionConflict') {
					throw new Error(localize('sessions.bots.userBotDeleteConflict', 'This Bot changed in another window. Choose Delete Bot again to review the latest version.'), { cause: error });
				}
				throw error;
			}
			this.storage.remove(userConversationKey(role.name), StorageScope.PROFILE);
			removed = isCurrent();
			if (removed) {
				this.bots.userBots.set(this.bots.userBots.get().filter(bot => bot.name !== role.name), undefined);
				this.bots.activeBot.set('user', undefined);
				status(localize('sessions.bots.userBotDeleted', '{0} was deleted.', role.name));
			}
		});
		if (!this.isVisible()) return;
		if (removed && this.bots.activeBot.get() === 'user') createButton.focus();
		else if (this.bots.activeBot.get() === selected && !trigger.domNode.hidden) trigger.focus();
	}

	private async saveUserBot(trigger: Button, isCurrent: () => boolean, token: CancellationToken, role?: AgentRoleDefinition): Promise<void> {
		const scope = this.scopes.getProviderScope(LOCAL_AGENT_HOST_PROVIDER_ID);
		const name = await showUserBotDialog(this.root, token, async definition => {
			const { session } = scope.services.host;
			scope.assertCurrent();
			try {
				if (role && session.updateUserRole) {
					await session.updateUserRole({ ...definition, expectedContentDigest: role.contentDigest });
				} else if (!role && session.createUserRole) {
					await session.createUserRole(definition);
				} else {
					throw new Error(localize('sessions.bots.userBotUnavailable', 'This Agent host cannot save personal Bots.'));
				}
			} catch (error) {
				if (error instanceof AppServerRemoteError && error.errorName === 'RevisionConflict') {
					throw new Error(localize('sessions.bots.userBotRevisionConflict', 'This Bot changed in another window. Reopen Edit Bot to load the latest version.'), { cause: error });
				}
				if (error instanceof AppServerRemoteError && error.errorName === 'ResourceNotFound') {
					throw new Error(localize('sessions.bots.userBotMissing', 'This Bot is no longer available.'), { cause: error });
				}
				if (error instanceof AppServerRemoteError && error.errorName === 'CommandConflict') {
					throw new Error(localize('sessions.bots.userBotConflict', 'A Bot with this name already exists.'), { cause: error });
				}
				if (error instanceof AppServerRemoteError && error.errorName === 'InvalidParams') {
					throw new Error(localize('sessions.bots.userBotInvalid', 'Check the Bot name and shorten its description or instructions.'), { cause: error });
				}
				throw error;
			}
		}, role);
		if (!isCurrent()) return;
		trigger.focus();
		if (!name) return;
		await this.refreshUserBots();
		if (!role && isCurrent()) this.bots.activeBot.set(userBotId(name), undefined);
	}

	private openUserBotConversation(): Promise<void> {
		const selected = this.bots.activeBot.get();
		const agent = this.bots.userBots.get().find(role => userBotId(role.name) === selected);
		if (!agent) return Promise.resolve();
		return this.runAction(selected, async (isCurrent, token) => {
			const target = await this.sessions.resolveNewSessionTarget();
			if (!isCurrent()) return;
			const active = await this.sessions.startNewSession(agent.name, {
				providerId: LOCAL_AGENT_HOST_PROVIDER_ID,
				workspace: target.providerId === LOCAL_AGENT_HOST_PROVIDER_ID && target.workspace.type === 'local' ? target.workspace : { type: 'current' },
				agent: { userDefined: true, name: agent.name, description: agent.description },
				creation: { kind: 'code', token },
			});
			// The Session catalog owns the conversation. This key remembers which one the Bot page is showing.
			this.storage.store(userConversationKey(agent.name), active.session.sessionId, StorageScope.PROFILE, StorageTarget.MACHINE);
			if (isCurrent()) this.chat.value?.focus();
		});
	}

	private async runAction(bot: BotId, action: (isCurrent: () => boolean, token: CancellationToken) => Promise<void>): Promise<void> {
		if (!this.isVisible() || this.busy.get() || this.bots.activeBot.get() !== bot || this.configuration.getValue<boolean>(ChatAIDisabledSettingId)) return;
		const source = new CancellationTokenSource();
		const navigationRevision = this.sessionViews.navigationRevision;
		const selectionRevision = this.sessions.navigationRevision;
		const lifetime = this.pendingAction.value = toDisposable(() => source.dispose(true));
		const isCurrent = () => this.pendingAction.value === lifetime && this.isVisible() && this.bots.activeBot.get() === bot
			&& navigationRevision === this.sessionViews.navigationRevision && selectionRevision === this.sessions.navigationRevision
			&& !this.configuration.getValue<boolean>(ChatAIDisabledSettingId);
		this.busy.set(true, undefined);
		try {
			await action(isCurrent, source.token);
		} catch (error) {
			if (isCurrent() && !isCancellationError(error)) this.notifications.error(toErrorMessage(error));
		} finally {
			if (this.pendingAction.value === lifetime) this.clearPendingAction();
		}
	}

	private clearPendingAction(): void {
		this.pendingAction.clear();
		this.busy.set(false, undefined);
	}

	private async runReviewer(isCurrent: () => boolean, token: CancellationToken): Promise<void> {
		const active = this.activeCodeThread();
		if (!active) return;
		const focus = await this.quickInput.input({
			title: localize('sessions.bots.reviewFocus', 'Review Focus'),
			placeHolder: localize('sessions.bots.reviewFocusPlaceholder', 'Optional focus for this and future reviews'),
			value: this.reviews.getReviewFocus(),
		}, token);
		if (focus === undefined || !isCurrent()) return;
		await this.reviews.runReviewer({ sessionId: active.session.sessionId, threadId: active.threadId },
			localize('sessions.bots.reviewerThread', 'Review saved changes'), focus.trim(), isCurrent);
	}

	private async askAdvisor(isCurrent: () => boolean, token: CancellationToken): Promise<void> {
		const active = this.activeCodeThread();
		if (!active) return;
		const sessionId = active.session.sessionId;
		const threadId = active.threadId;
		const scope = this.scopes.getScope(sessionId);
		const config = await scope.services.chat.readAdvisorDefault();
		if (!isCurrent()) return;
		scope.assertCurrent();
		if (!config?.enabled) {
			throw new Error(localize('sessions.bots.advisorDisabled', 'Choose an Advisor model with Configure Advisor before asking a question.'));
		}
		const question = await this.quickInput.input({
			title: localize('sessions.bots.askAdvisor', 'Ask Advisor'),
			placeHolder: localize('sessions.bots.advisorQuestion', 'Enter a question about the current Code conversation'),
			validateInput: async value => value.trim() ? undefined : localize('sessions.bots.advisorQuestionRequired', 'Enter a question.'),
		}, token);
		if (!question?.trim() || !isCurrent()) return;
		const { thread } = await this.chatService.readThread(sessionId, threadId, { type: 'latest', turnLimit: 1 });
		if (!isCurrent()) return;
		if (thread.turns.some(turn => !['completed', 'failed', 'interrupted'].includes(turn.status))) {
			throw new Error(localize('sessions.bots.advisorBusy', 'Wait for the current turn to finish before asking Advisor.'));
		}
		await this.chatService.consultAdvisor({ sessionId, threadId, expectedSequence: thread.sequence, question: question.trim() });
	}

	private bindAdvisorHistory(container: HTMLElement, active: IActiveSessionThread): void {
		const lifetime = this.advisorHistory.value = new DisposableStore();
		const { sessionId } = active.session;
		const { threadId } = active;
		const document = container.ownerDocument;
		const status = h(document, 'p', { attributes: { role: 'status' } }, localize('sessions.bots.loadingAdvisor', 'Loading Advisor history…'));
		const results = h(document, 'div');
		container.append(status, results);
		const history = { type: 'latest', turnLimit: 20 } as const;
		let lastRevision = -1;
		const render = ({ thread, transcript }: ThreadRead): void => {
			if (lifetime.isDisposed || transcript.revision < lastRevision) return;
			lastRevision = transcript.revision;
			const consultations = new Set(thread.turns.filter(turn => turn.kind === 'advisor').map(turn => turn.turnId));
			const errors = new Set(transcript.entries.flatMap(entry => entry.type === 'turnError' && consultations.has(entry.turnId) ? [entry.entryId] : []));
			const advice = chatTranscriptListItems(transcript.entries, undefined, thread.turns).filter(item => item.type === 'advisor' || errors.has(item.id));
			status.textContent = advice.length ? '' : localize('sessions.bots.noAdvisorHistory', 'No recent Advisor replies in this conversation.');
			results.replaceChildren(...advice.map(item => h(document, 'article',
				h(document, 'h2', item.label ?? advisorName),
				...(item.detail ? [h(document, 'p', item.detail)] : []),
				h(document, 'p', { className: 'ash-bots-advice' }, item.text),
			)));
		};
		const onError = (error: unknown): void => {
			if (!lifetime.isDisposed) status.textContent = localize('sessions.bots.advisorHistoryFailed', 'Could not load Advisor history. {0}', toErrorMessage(error));
		};
		const refresh = lifetime.add(new RunOnceScheduler(() => {
			void this.chatService.readThread(sessionId, threadId, history).then(render, onError);
		}, 100));
		lifetime.add(this.chatService.onDidUpdateThread(event => {
			if (event.sessionId === sessionId && event.threadId === threadId && event.update.type === 'committed'
				&& ['itemCompleted', 'turnCompleted', 'turnFailed', 'turnInterrupted'].includes(event.update.event.type)) refresh.schedule();
		}));
		const subscribe = () => this.chatService.subscribeThread(sessionId, threadId, 0, lifetime, history);
		const initial = subscribe();
		void initial.then(render, onError);
		lifetime.add(this.chatService.onDidBecomeReady(event => {
			if (!event || event.affectsSession(sessionId)) {
				lastRevision = -1;
				refresh.schedule();
			}
		}));
		lifetime.add(toDisposable(() => {
			const release = () => this.chatService.unsubscribeThread(sessionId, threadId, lifetime).catch(() => { });
			void initial.then(release, release);
		}));
	}

	private async openWorkspaceTask(isCurrent: () => boolean, token: CancellationToken): Promise<void> {
		const target = await this.sessions.resolveNewSessionTarget();
		if (!isCurrent()) return;
		const scope = this.scopes.getProviderScope(target.providerId);
		const catalog = await scope.services.host.session.readRoleCatalog();
		if (!isCurrent()) return;
		scope.assertCurrent();
		type Pick = IQuickPickItem & { readonly agent: ChatAgent; };
		const items = catalog.agents.flatMap((agent): Pick[] => agent.source.type === 'directory' && agent.launch === 'any' ? [{
			label: agent.name, detail: agent.description, description: agent.resource?.path,
			agent: { name: agent.name, description: agent.description, sourceId: agent.source.id },
		}] : []);
		if (!items.length) {
			this.notifications.info(localize('sessions.bots.noWorkspaceAgents', 'No launchable agents are defined in this workspace.'));
			return;
		}
		using resources = new DisposableStore();
		const picker = resources.add(this.quickInput.createQuickPick<Pick>());
		picker.ariaLabel = picker.placeholder = localize('sessions.bots.chooseWorkspaceAgent', 'Choose an agent from this workspace');
		picker.items = items;
		const picked = await new Promise<Pick | undefined>(resolve => {
			resources.add(picker.onDidHide(() => resolve(undefined)));
			resources.add(picker.onDidAccept(() => { resolve(picker.selectedItems[0]); picker.hide(); }));
			resources.add(token.onCancellationRequested(() => picker.hide()));
			picker.show();
		});
		if (picked && isCurrent()) {
			scope.assertCurrent();
			await this.openTask(picked.agent, isCurrent, target);
		}
	}

	private async openTask(agent: ChatAgent, isCurrent: () => boolean, target?: Awaited<ReturnType<ISessionsManagementService['resolveNewSessionTarget']>>): Promise<void> {
		const workspace = target ?? await this.sessions.resolveNewSessionTarget();
		if (!isCurrent()) return;
		const draft = this.sessionViews.openNewSession(undefined, workspace);
		this.sessions.setUntitledSessionAgent(draft.untitledSessionId, agent);
		await this.commands.executeCommand('sessions.open.code');
	}

	private markThreadViewed(reader?: IReader): void {
		const bot = this.bots.activeBot.read(reader);
		const entry = bot === reviewGroupId ? this.reviews.activeEntry.read(reader)
			: bot.startsWith('user:') ? this.userConversation(bot.slice('user:'.length)) : undefined;
		if (!entry || !this.chat.value || !this.isVisible()) return;
		const document = this.root.ownerDocument;
		if (!document.hidden && document.hasFocus() && isAncestorOfActiveElement(this.root)) {
			this.sessionViews.markVisibleThreadViewed({ sessionId: entry.session.sessionId, threadId: entry.threadId });
		}
	}

	private messagePresentation(target: CodeReviewTarget): ChatMessagePresentation {
		return {
			user: { name: localize('sessions.bots.you', 'You'), icon: Lxicon.account },
			assistant: { name: reviewName },
			getReferences: item => {
				const id = item.requestClientId;
				if (item.type !== 'userMessage' || !id?.startsWith(codeReviewRequestPrefix)) return [];
				const snapshot = this.reviews.snapshotForMessage(target, id);
				if (!snapshot) return [];
				return snapshot.batch.comments.map(comment => {
					const file = snapshot.batch.files.find(file => file.key === comment.file)!;
					const name = posix.basename(file.path);
					const label = comment.endLine
						? localize('sessions.bots.fileRange', '{0} · Lines {1}–{2}', name, comment.line, comment.endLine)
						: localize('sessions.bots.fileLine', '{0} · Line {1}', name, comment.line);
					const resource = codeReviewResource(snapshot.source, id).with({ fragment: comment.id });
					return { id: comment.id, label, open: trigger => void this.openComparison(resource, trigger) };
				});
			},
		};
	}

	private async openComparison(resource: URI, trigger?: HTMLElement): Promise<void> {
		if (trigger) this.returnFocus = trigger;
		if (!this.comparison.value) {
			const lifetime = this.comparison.value = new DisposableStore();
			const editor = this.comparisonEditor = lifetime.add(this.instantiation.createInstance(SessionCodeReviewEditor,
				(next: URI) => this.openComparison(next)));
			this.detail.hidden = false;
			editor.create(this.comparisonHost);
			editor.setVisible(true);
		}
		const editor = this.comparisonEditor!;
		this.comparisonError.hidden = true;
		const controller = new AbortController();
		const load = this.comparisonLoad.value = toDisposable(() => controller.abort());
		try {
			await editor.setInput({ resource }, controller.signal);
			if (this.comparisonLoad.value === load && this.isVisible()) {
				if (trigger) this.closeButton.focus();
				else editor.focus();
			}
		} catch (error) {
			if (!isCancellationError(error) && !controller.signal.aborted) {
				editor.clearInput();
				this.comparisonError.textContent = localize('sessions.codeReview.loadFailed', 'Could not load this comparison: {0}', toErrorMessage(error));
				this.comparisonError.hidden = false;
			}
		}
	}

	private closeComparison(restoreFocus: boolean): void {
		this.comparisonLoad.clear();
		this.comparison.clear();
		this.comparisonEditor = undefined;
		this.detail.hidden = true;
		if (restoreFocus) {
			const trigger = this.returnFocus;
			const referenceId = trigger?.dataset.chatReferenceId;
			const replacement = referenceId && Array.from(this.conversation.querySelectorAll<HTMLElement>('[data-chat-reference-id]'))
				.find(button => button.dataset.chatReferenceId === referenceId);
			if (trigger?.isConnected) trigger.focus();
			else if (replacement) replacement.focus();
			else this.focus();
		}
		this.returnFocus = undefined;
	}

	public getAccessibleContent(focused: Element | null): string {
		if (focused && this.detail.contains(focused)) return this.comparisonEditor?.getAccessibleContent() ?? '';
		const bot = this.bots.activeBot.get();
		return this.chat.value?.model.items.map(item => {
			const name = item.type === 'userMessage' ? localize('sessions.bots.you', 'You')
				: item.type === 'agentMessage' ? (bot.startsWith('user:') ? bot.slice('user:'.length) : reviewName) : item.label;
			return name ? name + '\n' + item.text : item.text;
		}).join('\n\n') || this.root.innerText;
	}

	public override async setInput(_input: IResourceEditorInput, signal: AbortSignal): Promise<void> { throwIfCancelled(signal); }
	public override clearInput(): void { this.closeComparison(false); }
	public override layout(dimension: IDimension): void {
		this.comparisonEditor?.layout(new Dimension(this.comparisonHost.clientWidth, dimension.height));
	}
	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.visible.set(visible, undefined);
		if (!visible) {
			this.userCatalogRevision++;
			this.clearPendingAction();
		}
		this.chat.value?.setVisible(visible);
		this.comparisonEditor?.setVisible(visible);
		if (visible) {
			void this.refreshUserBots().catch(error => { if (this.isVisible() && !isCancellationError(error)) this.notifications.error(toErrorMessage(error)); });
			this.markThreadViewed();
		}
	}
	public override focus(): void {
		if (this.chat.value) this.chat.value.focus();
		else this.root.focus();
	}
}
