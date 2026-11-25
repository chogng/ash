import { addDisposableListener, getActiveElement, getWindow, h } from '../../../../base/browser/dom.js';
import type { ContextMenuAnchor } from '../../../../base/browser/contextmenu.js';
import { observeIntersection } from '../../../../base/browser/observer.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { ContextViewHideReason } from '../../../../base/browser/ui/contextview/contextview.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProjectService } from '../../../../platform/projects/common/projectService.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { getChatListEntryActions, getChatListEntryProject, type ChatListEntry, type ChatListGroup } from '../../chat/browser/chatListModel.js';
import { SessionActionFeedback } from '../../sessions/browser/sessionActionFeedback.js';
import type { CatalogProjectCreator } from '../../sessions/browser/views/sessionsCatalogList.js';
import { catalogConversationActions, conversationMenuActions, sessionListProjectActions, startConversationRename } from '../../sessions/browser/views/sessionsListActions.js';
import { IProjectsService } from './projectsService.js';
import { ProjectListTimes } from './projectListTimes.js';

interface ProjectConversationsOptions {
	readonly isVisible: () => boolean;
	readonly createProjectForConversation: (creator: CatalogProjectCreator, restoreFocus: () => void) => void;
}

export class ProjectConversations extends Disposable {
	private readonly times: ProjectListTimes;
	private readonly openConversationRequest = this._register(new MutableDisposable());
	private readonly conversationMenu = this._register(new MutableDisposable<DisposableStore>());
	private readonly conversationFeedback = this._register(new SessionActionFeedback());

	constructor(
		private readonly body: HTMLElement,
		private readonly options: ProjectConversationsOptions,
		@IProjectsService private readonly projects: IProjectsService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@IHoverService hover: IHoverService,
		@INotificationService private readonly notifications: INotificationService,
		@IContextKeyService private readonly contexts: IContextKeyService,
		@IMenuService private readonly menus: IMenuService,
		@ICommandService private readonly commands: ICommandService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IProjectService private readonly projectService: IProjectService,
	) {
		super();
		this.times = this._register(new ProjectListTimes(hover, options.isVisible));
		this._register(addDisposableListener(body, 'keydown', event => this.navigateCards(event)));
	}

	reset(): void {
		this.times.reset();
		this.conversationMenu.clear();
	}

	renderConversations(container: HTMLElement, entries: readonly ChatListEntry[], project: ChatListGroup['project'], localProjectId: string | undefined, content: DisposableStore): void {
		const document = container.ownerDocument;
		const section = h(document, 'section', { className: 'ash-projects-conversations' });
		const label = localize('projects.conversations', 'Project conversations');
		container.append(section);
		const list = h(document, 'ul', { className: 'ash-projects-conversation-list', attributes: { 'aria-label': label } });
		const history = project?.history;
		const loading = history?.state === 'loading' || history?.state === 'idle';
		for (const entry of entries) {
			const row = h(document, 'li', { className: 'ash-projects-conversation-row' });
			const button = content.add(new Button(row, {
				...defaultButtonStyles,
				label: entry.title,
				ariaLabel: entry.title,
				icon: entry.defaultIcon,
				title: entry.title,
				enabled: !entry.disabled,
				onClick: () => this.openProjectConversation(entry),
			}));
			button.domNode.classList.add('ash-projects-conversation');
			button.domNode.dataset.projectControl = entry.id;
			const timestamp = entry.updatedAt ?? entry.createdAt;
			if (timestamp !== undefined) {
				button.domNode.append(this.times.render(button.domNode, timestamp, 'ash-projects-conversation-time',
					absoluteTime => localize('projects.conversationLastActivity', 'Last active {0}', absoluteTime), content));
			}
			if (!entry.disabled && !entry.actionsDisabled && (entry.sessionId || entry.rename || entry.getActions || entry.archive || entry.remove || entry.project || entry.externalConversationId)) {
				this.renderConversationMore(row, button, entry, localProjectId, content);
			}
			list.append(row);
		}
		if (entries.length) {
			list.setAttribute('aria-busy', String(loading));
			section.append(list);
			this.times.update(list);
		}
		if (history?.state === 'more' && history.manual) {
			const more = content.add(new Button(section, {
				...defaultButtonStyles,
				label: localize({ bundle: 'ash.sessions', key: 'sessions.list.moreProjectConversations' }, 'Load more conversations'),
				presentation: 'secondary',
				onClick: history.load,
			}));
			more.domNode.dataset.projectControl = 'project-history:more';
		} else if (history?.state === 'more') {
			const anchor = list.lastElementChild ?? section;
			let requested = false;
			const load = () => {
				if (requested || !anchor.isConnected || !this.options.isVisible()) return;
				requested = true;
				history.load();
			};
			content.add(observeIntersection(anchor, entry => { if (entry.isIntersecting) load(); }));
			content.add(addDisposableListener(anchor, 'focusin', () => queueMicrotask(load)));
		} else if (loading) {
			if (!entries.length) {
				const skeleton = h(document, 'div', {
					className: 'ash-projects-conversation-list',
					attributes: { 'aria-hidden': 'true' },
				});
				for (let index = 0; index < 3; index++) {
					skeleton.append(h(document, 'div', { className: 'ash-projects-conversation-placeholder' },
						h(document, 'span', { className: 'ash-projects-placeholder' }),
						h(document, 'span', { className: 'ash-projects-placeholder' }),
					));
				}
				section.append(skeleton);
			}
			section.append(h(document, 'p', {
				className: 'ash-aria-live',
				attributes: { role: 'status' },
			},
				localize('sessions.chatList.loadingProjectChats', 'Loading project chats…')));
		} else if (!entries.length && (!history || history.state === 'complete')) {
			const empty = h(document, 'div', { className: 'ash-projects-conversation-empty', attributes: { role: 'status' } });
			appendIcon(Lxicon.chatSession, empty);
			empty.append(h(document, 'p', {}, localize('sessions.chatList.emptyProject', 'No chats in this project')));
			section.append(empty);
		}
	}

	private renderConversationMore(row: HTMLElement, button: Button, entry: ChatListEntry, localProjectId: string | undefined, content: DisposableStore): void {
		const label = localize('sessions.list.more', 'More actions');
		const more = content.add(new Button(row, {
			...defaultButtonStyles, label, title: label, icon: Lxicon.ellipsis, iconOnly: true,
			ariaLabel: localize('projects.conversationActions', 'More actions for {0}', entry.title),
			onClick: () => open(more.domNode, more.domNode),
		}));
		more.domNode.classList.add('ash-projects-conversation-more');
		more.domNode.dataset.projectControl = `conversation-more:${entry.id}`;
		more.domNode.setAttribute('aria-haspopup', 'menu');
		more.domNode.setAttribute('aria-expanded', 'false');
		const open = (anchor: ContextMenuAnchor, trigger: HTMLElement) =>
			void this.showConversationMenu(row, button.domNode, more.domNode, entry, localProjectId, anchor, trigger, content);
		content.add(addDisposableListener(row, 'keydown', event => {
			if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
			if (row.classList.contains('renaming')) return;
			event.preventDefault();
			event.stopPropagation();
			const trigger = more.hasFocus() ? more.domNode : button.domNode;
			open(trigger, trigger);
		}));
		content.add(addDisposableListener(row, 'contextmenu', event => {
			if (row.classList.contains('renaming')) return;
			event.preventDefault();
			event.stopPropagation();
			open({ x: event.clientX, y: event.clientY, targetWindow: getWindow(row) }, button.domNode);
		}));
	}

	private async showConversationMenu(
		row: HTMLElement, button: HTMLButtonElement, more: HTMLButtonElement, entry: ChatListEntry, localProjectId: string | undefined,
		anchor: ContextMenuAnchor, trigger: HTMLElement, content: DisposableStore,
	): Promise<void> {
		const controller = new AbortController();
		const request = new DisposableStore();
		this.conversationMenu.value = request;
		const menuCancellation = new CancellationTokenSource();
		request.add(toDisposable(() => menuCancellation.dispose(true)));
		let loading = true;
		// Once displayed, a contributed action may use this signal after the menu closes.
		request.add(toDisposable(() => { if (loading) controller.abort(); }));
		const conversations = row.closest('.ash-projects-chat-content')!;
		const restoreFocus = () => {
			if (!conversations.isConnected || !this.options.isVisible()) return;
			const current = Array.from(conversations.querySelectorAll<HTMLElement>('.ash-projects-conversation'))
				.find(item => item.dataset.projectControl === entry.id);
			current?.focus({ preventScroll: true });
		};
		const rename = (run: NonNullable<ChatListEntry['rename']>) => {
			if (!row.isConnected || content.isDisposed) return;
			const store = content.add(new DisposableStore());
			row.classList.add('renaming');
			store.add(toDisposable(() => row.classList.remove('renaming')));
			const input = startConversationRename(row, store, this.notifications, {
				name: entry.title, rename: run, validate: entry.validateRename,
				finish: focus => {
					if (content.delete(store)) store.dispose();
					if (focus) restoreFocus();
				},
			});
			input.dataset.projectControl = entry.id;
		};
		try {
			const actions = await catalogConversationActions({
				...entry,
				getActions: signal => getChatListEntryActions(entry, signal, this.commands, this.configuration),
			}, controller.signal, rename, () => {
				const destinations = this.projects.state.get().projects.filter(project => !project.archived);
				const project = getChatListEntryProject(entry, destinations, this.projectService, localProjectId);
				if (!project) return [];
				const creator = project.creator;
				return sessionListProjectActions('chat', project, async run => {
					try { await run(); }
					finally { restoreFocus(); }
				}, creator && (() => this.options.createProjectForConversation(creator, restoreFocus)));
			});
			if (controller.signal.aborted || !row.isConnected || !this.options.isVisible()) return;
			loading = false;
			const context = request.add(this.contexts.createScoped(row));
			const target = entry.sessionId ? { sessionId: entry.sessionId } : { catalogId: entry.id };
			const menuActions = conversationMenuActions('chat', this.menus, this.commands, context, target, !!entry.pinned, actions).map(action => {
				if (action.id === 'agentSession.rename' && entry.rename) {
					const run = entry.rename;
					return { ...action, run: () => rename(run) };
				}
				if (action.id === 'agentSession.archive') {
					return { ...action, run: () => this.conversationFeedback.archive(row, () => action.run()) };
				}
				return action;
			});
			row.classList.add('menu-visible');
			more.setAttribute('aria-expanded', 'true');
			this.contextMenus.showContextMenu({
				getAnchor: () => anchor,
				getActions: () => menuActions,
				autoSelectFirstItem: anchor === trigger,
				cancellationToken: menuCancellation.token,
				onHide: (cancelled, reason) => {
					row.classList.remove('menu-visible');
					more.setAttribute('aria-expanded', 'false');
					if (this.conversationMenu.value !== request) return;
					this.conversationMenu.clear();
					if (cancelled && reason !== ContextViewHideReason.OutsidePointer && button.isConnected) {
						trigger.focus({ preventScroll: true });
					}
				},
			});
		} catch (error) {
			if (!controller.signal.aborted) this.notifications.error(toErrorMessage(error));
		} finally {
			if (loading && this.conversationMenu.value === request) this.conversationMenu.clear();
		}
	}

	private openProjectConversation(entry: ChatListEntry): void {
		const controller = new AbortController();
		this.openConversationRequest.value = toDisposable(() => controller.abort());
		void entry.open(controller.signal).catch(error => {
			if (!controller.signal.aborted) this.notifications.error(toErrorMessage(error));
		});
	}

	private navigateCards(event: KeyboardEvent): void {
		if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
			return;
		}
		const cards = Array.from(this.body.querySelectorAll<HTMLButtonElement>('.ash-projects-conversation:not(:disabled)'));
		const index = cards.indexOf(getActiveElement(this.body.ownerDocument) as HTMLButtonElement);
		if (index < 0) {
			return;
		}
		event.preventDefault();
		const next =
			event.key === 'Home'
				? 0
				: event.key === 'End'
					? cards.length - 1
					: index +
					(event.key === 'ArrowDown'
						? 1
						: event.key === 'ArrowUp'
							? -1
							: event.key === 'ArrowLeft'
								? -1
								: 1);
		cards[Math.max(0, Math.min(cards.length - 1, next))].focus();
	}
}
