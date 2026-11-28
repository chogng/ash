import { addDisposableListener, getActiveElement, h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Disposable, type DisposableStore } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { IProjectService, type ProjectSummary } from '../../../../platform/projects/common/projectService.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { getCatalogProjectPreview, getLocalProjectPreview, type ChatListGroup } from '../../chat/browser/chatListModel.js';
import { SessionListSection } from '../../sessions/browser/sessionListSection.js';
import { showSidebarProjectMenu, type ProjectsActions } from './projectsActions.js';
import { resolveProjectAppearance } from './projectAppearance.js';
import { IProjectsService, type ProjectsState } from './projectsService.js';

export class ProjectsList extends Disposable {
	private readonly menuContext: IContextKeyService;

	constructor(
		private readonly body: HTMLElement,
		private readonly actions: ProjectsActions,
		@IProjectsService private readonly projects: IProjectsService,
		@IProjectService private readonly projectService: IProjectService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@IHoverService private readonly hover: IHoverService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super();
		this.menuContext = this._register(contextKeys.createScoped(body));
		this._register(addDisposableListener(body, 'keydown', event => this.navigateCards(event)));
	}

	focusCard(id?: string): boolean {
		const cards = this.body.querySelectorAll<HTMLButtonElement>('button.ash-projects-card, button[data-project-control^="restore:"]');
		const card = id === undefined ? cards[0] : Array.from(cards).find(candidate => candidate.dataset.projectControl === id);
		card?.focus();
		return !!card;
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
		for (const { id, name, source, project } of rows) {
			const row = disposables.add(this.instantiation.createInstance(SessionListSection, document, id, 'project', 'chat', undefined, undefined));
			row.domNode.classList.add('ash-projects-row');
			row.button.classList.add('ash-projects-card');
			row.button.dataset.projectControl = id;
			const preferenceKey = source === 'catalog' ? project.project?.preferenceKey : undefined;
			const appearance = resolveProjectAppearance(document, source === 'local' ? project
				: preferenceKey ? this.projects.getCatalogProjectAppearance(preferenceKey) : undefined);
			row.update(name, {
				...appearance,
				open: () => {
					const state = this.projects.state.get();
					if (source === 'local') {
						if (state.selectedId !== id || state.message) void this.projects.openProject(id);
					} else if (state.conversationProjectId !== id) {
						this.projects.openConversationProject(id);
					}
				},
			});
			const details = source === 'local'
				? getLocalProjectPreview(project, async () => (await this.projectService.read(project.id, 'chat')).description)
				: getCatalogProjectPreview(project);
			row.preview?.update(this.hover, { kind: 'project', title: name, details });
			row.setContextMenu(anchor => showSidebarProjectMenu(this.contextMenus, this.menuContext, 'chat', this.actions.getProjectMenuTarget(project), {
				getAnchor: () => anchor,
				menuTarget: { element: row.domNode, getExpandedTrigger: anchor === row.moreButton ? () => row.moreButton : undefined },
			}));
			const more = row.moreButton;
			if (more) more.dataset.projectControl = `more:${id}`;
			list.append(h(document, 'li', {}, row.domNode));
		}
		this.body.append(list);
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
				{ className: 'ash-sessions-list-section-toggle ash-projects-skeleton-card' },
				placeholder('ash-sessions-list-section-icon'),
				placeholder('ash-projects-skeleton-name'),
			);
			skeleton.append(h(document, 'div', { className: 'ash-sessions-list-project-row ash-sessions-list-project-navigation ash-sessions-list-subgroup' },
				h(document, 'div', { className: 'ash-sessions-list-section-heading' }, card),
			));
		}
		this.body.append(skeleton);
	}

	updateSelection(id: string | undefined): void {
		for (const button of this.body.querySelectorAll<HTMLButtonElement>('button.ash-projects-card')) {
			const selected = button.dataset.projectControl === id;
			button.closest('.ash-projects-row')?.classList.toggle('selected', selected);
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
