import type { IAction } from '../../../../base/common/actions.js';
import { addDisposableListener, getActiveElement, h } from '../../../../base/browser/dom.js';
import { ButtonActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Disposable, type DisposableStore } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import type { ProjectSummary } from '../../../../platform/projects/common/projectService.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import type { ChatListGroup } from '../../chat/browser/chatListModel.js';
import type { ProjectsActions } from './projectsActions.js';
import { resolveProjectAppearance } from './projectAppearance.js';
import { IProjectsService, type ProjectsState } from './projectsService.js';
import { ProjectListTimes } from './projectListTimes.js';

/** A pinned project shows its removal action in the same slot on hover or focus. */
class ProjectsPinActionViewItem extends ButtonActionViewItem {
	override render(container: HTMLElement): void {
		super.render(container);
		if (!this.action.checked) {
			return;
		}
		container.classList.add('pinned');
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

export class ProjectsList extends Disposable {
	private readonly times: ProjectListTimes;

	constructor(
		private readonly body: HTMLElement,
		private readonly actions: ProjectsActions,
		isVisible: () => boolean,
		@IProjectsService private readonly projects: IProjectsService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@IHoverService private readonly hover: IHoverService,
	) {
		super();
		this.times = this._register(new ProjectListTimes(hover, isVisible));
		this._register(addDisposableListener(body, 'keydown', event => this.navigateCards(event)));
	}

	focusCard(id?: string): boolean {
		const cards = this.body.querySelectorAll<HTMLButtonElement>('button.ash-projects-card, button[data-project-control^="restore:"]');
		const card = id === undefined ? cards[0] : Array.from(cards).find(candidate => candidate.dataset.projectControl === id);
		card?.focus();
		return !!card;
	}

	reset(): void {
		this.times.reset();
	}

	renderCards(projects: readonly ProjectSummary[], conversationCards: readonly ChatListGroup[], disposables: DisposableStore): void {
		const document = this.body.ownerDocument;
		const list = h(document, 'ul', {
			className: 'ash-projects-grid',
			attributes: { 'aria-label': localize('projects.title', 'Projects') },
		});
		const rows = [
			...projects.map(project => ({ ...project, source: 'local' as const, project })),
			...conversationCards.map(project => ({
				id: project.key, name: project.title, updatedAtMs: project.project?.updatedAt,
				createdAtMs: project.project?.createdAt, source: 'catalog' as const, project,
			})),
		].sort((left, right) => this.projects.compareProjectOrder(left, right));
		for (const { id, name, updatedAtMs, createdAtMs, source, project } of rows) {
			const row = h(document, 'li', { className: 'ash-projects-row' });
			const card = h(document, 'button', {
				className: 'ash-button ash-button-quiet ash-projects-card',
				properties: { type: 'button' },
			});
			card.dataset.projectControl = id;
			const mark = h(document, 'span', { className: 'ash-projects-card-mark', attributes: { 'aria-hidden': 'true' } });
			const preferenceKey = source === 'catalog' ? project.project?.preferenceKey : undefined;
			const appearance = resolveProjectAppearance(document, source === 'local' ? project
				: preferenceKey ? this.projects.getCatalogProjectAppearance(preferenceKey) : undefined);
			appendIcon(appearance.icon ?? Lxicon.projects, mark);
			if (appearance.color) mark.style.color = appearance.color;
			card.append(mark, this.renderCardContent(card, name, updatedAtMs, disposables, createdAtMs));
			disposables.add(this.hover.setupDelayedHover(card, { content: name }));
			disposables.add(addDisposableListener(card, 'click', () => {
				const state = this.projects.state.get();
				if (source === 'local') {
					if (state.selectedId !== id || state.message) void this.projects.openProject(id);
				} else if (state.conversationProjectId !== id) {
					this.projects.openConversationProject(id);
				}
			}));
			const actions = source === 'local' ? this.actions.getProjectActions(project) : this.actions.getConversationProjectActions(project);
			row.append(card, this.renderCardActions(row, id, name, actions, disposables));
			list.append(row);
		}
		this.body.append(list);
		this.times.update(list);
	}

	private renderCardContent(card: HTMLButtonElement, title: string, updatedAt: number | undefined, disposables: DisposableStore, createdAt?: number): HTMLElement {
		const document = card.ownerDocument;
		card.setAttribute('aria-label', title);
		const content = h(document, 'span', { className: 'ash-projects-card-content' },
			h(document, 'span', { className: 'ash-projects-card-name' }, title),
		);
		const timestamp = updatedAt ?? createdAt;
		if (timestamp !== undefined) {
			content.append(this.times.render(card, timestamp, 'ash-projects-card-caption', absoluteTime => updatedAt === undefined
				? localize('projects.createdAt', 'Created {0}', absoluteTime)
				: localize('projects.updatedAt', 'Updated {0}', absoluteTime), disposables));
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

	updateSelection(id: string | undefined): void {
		for (const button of this.body.querySelectorAll<HTMLButtonElement>('button.ash-projects-card')) {
			const selected = button.dataset.projectControl === id;
			button.parentElement?.classList.toggle('selected', selected);
			if (selected) button.setAttribute('aria-current', 'true');
			else button.removeAttribute('aria-current');
		}
	}

	private navigateCards(event: KeyboardEvent): void {
		if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		const rows = Array.from(this.body.querySelectorAll<HTMLButtonElement>('button.ash-projects-card, button[data-project-control^="restore:"]:not(:disabled)'));
		const index = rows.indexOf(getActiveElement(this.body.ownerDocument) as HTMLButtonElement);
		if (index < 0) return;
		event.preventDefault();
		const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : index + (event.key === 'ArrowUp' ? -1 : 1);
		rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
	}
}
