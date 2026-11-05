import type { IAction } from '../../../../base/common/actions.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { ButtonActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { AnchorAlignment, AnchorPosition } from '../../../../base/browser/ui/contextview/contextview.js';
import { DropdownMenuActionViewItem } from '../../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { ToolbarSearchActionViewItem } from '../../../browser/ui/toolbarSearchActionViewItem.js';
import type { ProjectsActions } from './projectsActions.js';
import { IProjectsService, type ProjectsState } from './projectsService.js';

export class ProjectsToolbar extends Disposable {
	private readonly search: HTMLInputElement;
	private searchActionViewItem!: ToolbarSearchActionViewItem;
	private readonly tools: HTMLElement;
	private readonly toolbar: WorkbenchToolBar;
	private toolbarActions: readonly IAction[];
	private createActionViewItem!: ButtonActionViewItem;
	private sortDropdown!: DropdownMenuActionViewItem;
	private sortMenuOpen = false;

	constructor(
		container: HTMLElement,
		actions: ProjectsActions,
		toggleArchived: () => void,
		@IProjectsService private readonly projects: IProjectsService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
	) {
		super();
		const document = container.ownerDocument;
		this.search = h(document, 'input', {
			className: 'ash-projects-search',
			properties: { type: 'search', placeholder: localize('projects.search', 'Search projects') },
			attributes: { 'aria-label': localize('projects.search', 'Search projects') },
		});
		this.toolbar = this._register(
			new WorkbenchToolBar(container, this.contextMenus, {
				ariaLabel: localize('projects.toolbar', 'Project actions'),
				actionViewItemProvider: (action, options) => {
					if (action.id === 'projects.search') {
						this.searchActionViewItem = new ToolbarSearchActionViewItem(
							action,
							options,
							this.search,
							() => {
								this.projects.setQuery('');
								this.setSearchVisible(false);
								this.searchActionViewItem.focus();
							},
							localize('projects.closeSearch', 'Close project search'),
						);
						return this.searchActionViewItem;
					}
					if (action.id === 'projects.sort') {
						const item = new DropdownMenuActionViewItem(
							action,
							() => actions.getSortActions(),
							{
								showContextMenu: delegate =>
									this.contextMenus.showContextMenu({
										...delegate,
										anchorPosition: AnchorPosition.Below,
										getMenuClassName: () => 'ash-projects-sort-menu',
										getCheckedActionsRepresentation: () => 'radio',
									}),
							},
							options,
							() => ({ anchorAlignment: AnchorAlignment.Right }),
						);
						this.sortDropdown = item;
						this._register(
							item.onDidChangeVisibility(visible => {
								this.sortMenuOpen = visible;
							}),
						);
						return item;
					}
					if (action.id === 'projects.create') {
						this.createActionViewItem = new ButtonActionViewItem(action, {
							...options,
							buttonPresentation: 'primary',
						});
						return this.createActionViewItem;
					}
					return undefined;
				},
			}),
		);
		this.tools = this.toolbar.element;
		this.tools.classList.add('ash-projects-tools');
		const searchLabel = localize('projects.search', 'Search projects');
		const sortLabel = localize('projects.sort', 'Sort projects');
		const createLabel = localize('projects.new', 'New project');
		const archivedLabel = localize('projects.archived', 'Archived');
		this.toolbarActions = [
			{
				id: 'projects.search',
				label: searchLabel,
				tooltip: searchLabel,
				icon: Lxicon.search,
				enabled: true,
				run: () => {
					this.setSearchVisible(true);
					this.search.focus();
				},
			},
			{
				id: 'projects.sort',
				label: sortLabel,
				tooltip: sortLabel,
				icon: Lxicon.sort,
				enabled: true,
				run: () => this.sortDropdown.show(),
			},
			{
				id: 'projects.archived',
				label: archivedLabel,
				tooltip: archivedLabel,
				enabled: true,
				run: toggleArchived,
			},
			{
				id: 'projects.create',
				label: createLabel,
				tooltip: '',
				enabled: true,
				run: () => actions.createProject(),
			},
		];
		this.toolbar.setActions(this.toolbarActions);
		this._register(addDisposableListener(this.search, 'input', () => this.projects.setQuery(this.search.value)));
	}

	update(state: Pick<ProjectsState, 'query' | 'busy'>, catalogVisible: boolean, archived: boolean): void {
		this.tools.querySelector('[data-action-id="projects.archived"] button')?.setAttribute('aria-pressed', String(archived));
		this.setSearchVisible(catalogVisible && (this.searchActionViewItem.expanded || !!state.query));
		this.search.value = state.query;
		const createAction = this.toolbarActions.find(action => action.id === 'projects.create')!;
		if (createAction.enabled === state.busy) {
			// Keep the search and dropdown items mounted while the primary action changes availability.
			this.toolbarActions = this.toolbarActions.map(action =>
				action === createAction ? { ...action, enabled: !state.busy } : action,
			);
			this.toolbar.setActions(this.toolbarActions);
		}
	}

	focusCreate(): void {
		this.createActionViewItem.focus();
	}

	closeSortMenu(): void {
		if (this.sortMenuOpen) this.contextMenus.hideContextMenu();
	}

	private setSearchVisible(visible: boolean): void {
		this.searchActionViewItem.setExpanded(visible);
	}
}
