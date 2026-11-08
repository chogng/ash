import { h } from '../../../../base/browser/dom.js';
import { Disposable, type DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { ChatListGroup } from '../../chat/browser/chatListModel.js';
import type { ProjectsActions } from './projectsActions.js';
import type { ProjectsList } from './projectsList.js';
import { IProjectsService, type ProjectsState } from './projectsService.js';
import { ProjectsToolbar } from './projectsToolbar.js';
import { renderProjectsWelcomePage } from './projectsWelcomePage.js';

/** The Projects overview selects which catalogue content to show in the editor. */
export class ProjectsView extends Disposable {
	readonly heading: HTMLElement;
	private readonly title: HTMLHeadingElement;
	private readonly toolbar: ProjectsToolbar;

	constructor(
		private readonly body: HTMLElement,
		private readonly list: ProjectsList,
		private readonly actions: ProjectsActions,
		@IProjectsService private readonly projects: IProjectsService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		const document = body.ownerDocument;
		this.heading = h(document, 'header', { className: 'ash-projects-heading' });
		this.title = h(document, 'h1', { properties: { tabIndex: -1 } }, localize('projects.title', 'Projects'));
		this.heading.append(this.title);
		this.toolbar = this._register(instantiation.createInstance(ProjectsToolbar, this.heading, actions));
	}

	render(state: ProjectsState, visible: boolean, groups: readonly ChatListGroup[], archived: readonly ChatListGroup[] | undefined, content: DisposableStore): void {
		this.heading.hidden = !visible;
		this.toolbar.update(state, visible);
		if (!visible) {
			this.toolbar.closeSortMenu();
			return;
		}

		const title = archived ? localize('projects.archived', 'Archived') : localize('projects.title', 'Projects');
		this.title.textContent = title;
		this.title.title = title;
		const query = state.query.trim().toLocaleLowerCase();
		if (archived) {
			this.list.renderArchivedProjects(state, archived, query, content);
			return;
		}

		const localIds = new Set(state.projects.map(project => project.id));
		const conversationCards = groups.filter(group => !localIds.has(group.key) && group.title.toLocaleLowerCase().includes(query));
		const projects = this.projects.getProjects();
		if (projects.length || conversationCards.length) {
			this.list.renderCards(projects, conversationCards, content);
		} else if (state.loading) {
			this.list.renderLoading();
		} else if (!state.message) {
			const onClick = state.query ? () => this.projects.setQuery('') : () => this.actions.createProject();
			renderProjectsWelcomePage(this.body, !!state.query, onClick, content);
		}
	}

	focusHeading(): void {
		this.title.focus();
	}

	focusCreate(): void {
		this.toolbar.focusCreate();
	}

	closeSortMenu(): void {
		this.toolbar.closeSortMenu();
	}
}
