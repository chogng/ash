import type { IAction } from '../../../../base/common/actions.js';
import { addDisposableListener, getActiveElement, h } from '../../../../base/browser/dom.js';
import { observeIntersection } from '../../../../base/browser/observer.js';
import { ButtonActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { appendIcon, getRegisteredIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { formatTimeAgo } from '../../../../base/common/date.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Disposable, MutableDisposable, toDisposable, type DisposableStore } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { getNLSLanguage, localize } from '../../../../nls.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { ProjectSummary } from '../../../../platform/projects/common/projectService.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { colorCssVariable } from '../../../../platform/theme/common/colorUtils.js';
import type { ChatListEntry, ChatListGroup } from '../../chat/browser/chatListModel.js';
import type { ProjectsActions } from './projectsActions.js';
import { IProjectsService, type ProjectsState } from './projectsService.js';

/** A pinned project shows its removal action in the same slot on hover or focus. */
class ProjectsPinActionViewItem extends ButtonActionViewItem {
	override render(container: HTMLElement): void {
		super.render(container);
		if (!this.action.checked) {
			return;
		}
		const button = this.button.domNode;
		const updateIcon = () => {
			this.button.icon = button.matches(':hover, :focus') ? Lxicon.unpin : this.action.icon;
		};
		for (const event of ['mouseenter', 'mouseleave', 'focus', 'blur'] as const) {
			this._register(addDisposableListener(button, event, updateIcon));
		}
		updateIcon();
	}
}

interface ProjectsListOptions {
	readonly openedProject: () => void;
	readonly isVisible: () => boolean;
}

/** Renders the project catalogue and its conversation lists in the pane's body. */
export class ProjectsList extends Disposable {
	private readonly relativeTimeUpdate = this._register(new IntervalTimer());
	private readonly relativeTime = new Intl.RelativeTimeFormat(getNLSLanguage(), { numeric: 'always' });
	private readonly openConversationRequest = this._register(new MutableDisposable());

	constructor(
		private readonly body: HTMLElement,
		private readonly actions: ProjectsActions,
		private readonly options: ProjectsListOptions,
		@IProjectsService private readonly projects: IProjectsService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@IHoverService private readonly hover: IHoverService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this._register(addDisposableListener(body, 'keydown', event => this.navigateCards(event)));
	}

	focusCard(id?: string): boolean {
		const cards = this.body.querySelectorAll<HTMLButtonElement>('.ash-projects-card');
		const card = id === undefined ? cards[0] : Array.from(cards).find(candidate => candidate.dataset.projectControl === id);
		card?.focus();
		return !!card;
	}

	stopUpdatingTimes(): void {
		this.relativeTimeUpdate.cancel();
	}

	renderCards(projects: readonly ProjectSummary[], conversationCards: readonly ChatListGroup[], disposables: DisposableStore): void {
		const document = this.body.ownerDocument;
		const list = h(document, 'ul', {
			className: 'ash-projects-grid',
			attributes: { 'aria-label': localize('projects.title', 'Projects') },
		});
		for (const project of projects) {
			const row = h(document, 'li', { className: 'ash-projects-row' });
			const card = h(document, 'button', {
				className: 'ash-button ash-button-quiet ash-projects-card',
				properties: { type: 'button' },
			});
			card.dataset.projectControl = project.id;
			const mark = h(document, 'span', {
				className: 'ash-projects-card-mark',
				attributes: { 'aria-hidden': 'true' },
			});
			appendIcon((project.icon && getRegisteredIcon(project.icon, document)) || Lxicon.projects, mark);
			if (project.color) mark.style.color = `var(${colorCssVariable(project.color)})`;
			card.append(mark, this.renderCardContent(card, project.name, project.updatedAtMs, disposables, project.createdAtMs));
			const actionsHost = this.renderCardActions(row, project.id, project.name, this.actions.getProjectActions(project), disposables);
			disposables.add(this.hover.setupDelayedHover(card, { content: project.name }));
			disposables.add(
				addDisposableListener(card, 'click', () => {
					void this.projects.openProject(project.id).then(() => this.options.openedProject());
				}),
			);
			row.append(card, actionsHost);
			list.append(row);
		}
		for (const project of conversationCards) {
			const row = h(document, 'li', { className: 'ash-projects-row' });
			const card = h(document, 'button', {
				className: 'ash-button ash-button-quiet ash-projects-card',
				properties: { type: 'button' },
			});
			card.dataset.projectControl = project.key;
			card.dataset.conversationProject = '';
			const mark = h(document, 'span', { className: 'ash-projects-card-mark', attributes: { 'aria-hidden': 'true' } });
			const key = project.project?.preferenceKey;
			const appearance = key ? this.projects.getCatalogProjectAppearance(key) : undefined;
			appendIcon((appearance?.icon && getRegisteredIcon(appearance.icon, document)) || Lxicon.projects, mark);
			if (appearance?.color) mark.style.color = `var(${colorCssVariable(appearance.color)})`;
			card.append(mark, this.renderCardContent(card, project.title, project.project?.updatedAt, disposables, project.project?.createdAt));
			disposables.add(addDisposableListener(card, 'click', () => {
				this.projects.openConversationProject(project.key);
				this.options.openedProject();
			}));
			row.append(card, this.renderCardActions(row, project.key, project.title, this.actions.getConversationProjectActions(project), disposables));
			list.append(row);
		}
		this.body.append(list);
		this.updateCardTimes();
		if (this.options.isVisible() && list.querySelector('time')) {
			this.relativeTimeUpdate.cancelAndSet(() => this.updateCardTimes(), 60_000, document.defaultView!);
		}
	}

	private renderCardContent(card: HTMLButtonElement, title: string, updatedAt: number | undefined, disposables: DisposableStore, createdAt?: number): HTMLElement {
		const document = card.ownerDocument;
		card.setAttribute('aria-label', title);
		const content = h(document, 'span', { className: 'ash-projects-card-content' },
			h(document, 'span', { className: 'ash-projects-card-name' }, title),
		);
		const timestamp = updatedAt ?? createdAt;
		if (timestamp !== undefined) {
			const date = new Date(timestamp);
			const absoluteTime = date.toLocaleString(getNLSLanguage());
			const description = updatedAt === undefined
				? localize('projects.createdAt', 'Created {0}', absoluteTime)
				: localize('projects.updatedAt', 'Updated {0}', absoluteTime);
			const caption = h(document, 'time', {
				className: 'ash-projects-card-caption',
				properties: { dateTime: date.toISOString(), id: generateUuid() },
				attributes: { 'aria-label': description },
			});
			card.setAttribute('aria-describedby', caption.id);
			content.append(caption);
			disposables.add(this.hover.setupDelayedHover(caption, { content: description }));
		}
		return content;
	}

	renderArchivedProjects(state: ProjectsState, groups: readonly ChatListGroup[], query: string, content: DisposableStore): void {
		const document = this.body.ownerDocument;
		const projects = [
			...state.projects.filter(project => project.archived).map(project => ({
				id: project.id, title: project.name, restore: () => this.projects.restore(project),
			})),
			...groups.flatMap(group => group.project?.restore ? [{
				id: group.key, title: group.title, restore: group.project.restore,
			}] : []),
		].filter(project => project.title.toLocaleLowerCase().includes(query))
			.sort((left, right) => left.title.localeCompare(right.title));
		if (!projects.length) {
			this.body.append(h(document, 'p', { attributes: { role: 'status' } }, query
				? localize('projects.noMatchingArchived', 'No matching archived projects.')
				: localize('projects.noArchived', 'No archived projects.')));
			return;
		}
		const list = h(document, 'ul', {
			className: 'ash-projects-grid',
			attributes: { 'aria-label': localize('projects.archived', 'Archived') }
		});
		for (const project of projects) {
			const row = h(document, 'li', { className: 'ash-projects-row' });
			const button = content.add(new Button(row, {
				...defaultButtonStyles,
				label: localize('projects.restoreNamed', 'Unarchive {0}', project.title),
				icon: Lxicon.archive,
				onClick: () => {
					this.actions.restoreProject(project.restore);
				},
			}));
			button.enabled = !state.busy;
			button.domNode.dataset.projectControl = `restore:${project.id}`;
			list.append(row);
		}
		this.body.append(list);
	}

	private renderCardActions(row: HTMLElement, id: string, title: string, actions: readonly IAction[], content: DisposableStore): HTMLElement {
		const actionsHost = h(row.ownerDocument, 'div', { className: 'ash-projects-card-actions' });
		const pinned = this.projects.isPinned(id);
		const pinLabel = pinned ? localize('projects.unpin', 'Unpin') : localize('projects.pin', 'Pin');
		const pin: IAction = {
			id: 'projects.pin',
			label: pinLabel,
			tooltip: pinLabel,
			icon: pinned ? Lxicon.pinFilled : Lxicon.pinned,
			enabled: !this.projects.state.get().busy,
			checked: pinned,
			run: () => this.projects.togglePinned(id),
		};
		const toolbar = content.add(
			new WorkbenchToolBar(
				actionsHost,
				{
					showContextMenu: delegate => {
						row.classList.add('menu-visible');
						this.contextMenus.showContextMenu({
							...delegate,
							getMenuClassName: () => 'ash-projects-menu',
							onHide: didCancel => {
								row.classList.remove('menu-visible');
								delegate.onHide?.(didCancel);
							},
						});
					},
				},
				{
					ariaLabel: localize('projects.actions', 'Actions for {0}', title),
					presentation: 'inherit-foreground',
					highlightToggledItems: false,
					actionViewItemProvider: (action, options) =>
						action.id === 'projects.pin' ? new ProjectsPinActionViewItem(action, options) : undefined,
				},
			),
		);
		toolbar.setActions([], actions, [this.actions.getPinAction(id)]);
		const pinButton = actionsHost.querySelector<HTMLElement>('[data-action-id="projects.pin"] button')!;
		pinButton.dataset.projectControl = `pin:${id}`;
		const moreButton = actionsHost.querySelector<HTMLElement>('.ash-toolbar-more-actions button')!;
		if (moreButton) moreButton.dataset.projectControl = `more:${id}`;
		return actionsHost;
	}

	renderConversations(container: HTMLElement, entries: readonly ChatListEntry[], project: ChatListGroup['project'], content: DisposableStore): void {
		const document = container.ownerDocument;
		const section = h(document, 'section', { className: 'ash-projects-conversations' });
		const label = localize('projects.conversations', 'Project conversations');
		const heading = h(document, 'h2', { properties: { id: generateUuid() } }, label);
		section.append(h(document, 'div', { className: 'ash-projects-section-heading' }, heading));
		container.append(section);
		const list = h(document, 'ul', { className: 'ash-projects-conversation-list', attributes: { 'aria-labelledby': heading.id } });
		const history = project?.history;
		const loading = history?.state === 'loading' || history?.state === 'idle';
		for (const entry of entries) {
			const row = h(document, 'li');
			const button = content.add(new Button(row, {
				...defaultButtonStyles,
				label: entry.title,
				icon: entry.defaultIcon,
				title: entry.title,
				enabled: !entry.disabled,
				onClick: () => this.openProjectConversation(entry),
			}));
			button.domNode.classList.add('ash-projects-conversation');
			button.domNode.dataset.projectControl = entry.id;
			list.append(row);
		}
		if (entries.length) {
			list.setAttribute('aria-busy', String(loading));
			section.append(list);
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
			const anchor = list.lastElementChild ?? heading;
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

	private openProjectConversation(entry: ChatListEntry): void {
		const controller = new AbortController();
		this.openConversationRequest.value = toDisposable(() => controller.abort());
		void entry.open(controller.signal).catch(error => {
			if (!controller.signal.aborted) this.notifications.error(toErrorMessage(error));
		});
	}

	private updateCardTimes(): void {
		const now = Date.now();
		// Refresh text in place so time passing never replaces cards or interrupts keyboard focus.
		for (const caption of this.body.querySelectorAll<HTMLTimeElement>('time.ash-projects-card-caption')) {
			caption.textContent = formatTimeAgo(Date.parse(caption.dateTime), now, this.relativeTime)
				?? localize('projects.justNow', 'Just now');
		}
	}

	renderLoading(): void {
		const document = this.body.ownerDocument;
		const placeholder = (className: string) =>
			h(document, 'span', { className: `ash-projects-placeholder ${className}` });
		const skeleton = h(document, 'div', {
			className: 'ash-projects-skeleton ash-projects-grid',
			attributes: { 'aria-hidden': 'true' },
		});
		for (let index = 0; index < 6; index++) {
			const card = h(
				document,
				'div',
				{ className: 'ash-projects-card ash-projects-skeleton-card' },
				placeholder('ash-projects-card-mark'),
				h(
					document,
					'div',
					{ className: 'ash-projects-card-content' },
					placeholder('ash-projects-skeleton-name'),
					placeholder('ash-projects-skeleton-short'),
				),
			);
			skeleton.append(h(document, 'div', { className: 'ash-projects-row' }, card));
		}
		this.body.append(skeleton);
	}

	private navigateCards(event: KeyboardEvent): void {
		if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
			return;
		}
		const cards = Array.from(this.body.querySelectorAll<HTMLButtonElement>('.ash-projects-card, .ash-projects-conversation:not(:disabled)'));
		const index = cards.indexOf(getActiveElement(this.body.ownerDocument) as HTMLButtonElement);
		if (index < 0) {
			return;
		}
		event.preventDefault();
		const columns = getComputedStyle(cards[index].parentElement!.parentElement!).gridTemplateColumns.split(
			' ',
		).length;
		const next =
			event.key === 'Home'
				? 0
				: event.key === 'End'
					? cards.length - 1
					: index +
					(event.key === 'ArrowDown'
						? columns
						: event.key === 'ArrowUp'
							? -columns
							: event.key === 'ArrowLeft'
								? -1
								: 1);
		cards[Math.max(0, Math.min(cards.length - 1, next))].focus();
	}
}
