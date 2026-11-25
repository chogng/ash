import { getActiveElement, h, isHTMLElement } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { autorun, derived, observableValue } from '../../../../../base/common/observable.js';
import { localize } from '../../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { ViewPane, type IViewPaneOptions } from '../../../../../workbench/browser/parts/views/viewPane.js';
import { groupChatList, IChatListCatalog } from '../../../chat/browser/chatListModel.js';
import { IEditorPart } from '../../../../../workbench/browser/parts/editor/editorPart.js';
import type { ChatProjectEdit } from '../projectDialogService.js';
import { ProjectsActions } from '../projectsActions.js';
import { ProjectsEditorPane } from '../projectsEditor.js';
import { ProjectsList } from '../projectsList.js';
import { IProjectsService } from '../projectsService.js';
import { ProjectsToolbar } from '../projectsToolbar.js';
import '../media/projectsView.css';

export class ProjectsView extends ViewPane {
	private readonly content = this._register(new DisposableStore());
	private readonly bodyVisible = observableValue(this, false);
	private readonly showArchived = observableValue(this, false);
	private readonly archivedHeading: HTMLHeadingElement;
	private readonly body: HTMLElement;
	private readonly actions: ProjectsActions;
	private readonly toolbar: ProjectsToolbar;
	private readonly list: ProjectsList;

	constructor(
		parent: HTMLElement,
		options: IViewPaneOptions,
		@IProjectsService private readonly projects: IProjectsService,
		@IChatListCatalog catalog: IChatListCatalog,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibleViewService accessible: IAccessibleViewService,
		@IEditorPart editors: IEditorPart,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super(parent, options);
		const document = parent.ownerDocument;
		const title = localize('projects.title', 'Projects');
		const archivedTitle = localize('projects.archived', 'Archived');
		const root = h(document, 'nav', { className: 'ash-projects-view', attributes: { 'aria-label': title } });
		this.archivedHeading = h(document, 'h2', {
			className: 'ash-projects-archived-heading',
			properties: { tabIndex: -1, hidden: true },
		}, archivedTitle);
		this.body = h(document, 'div', { className: 'ash-projects-view-list', properties: { tabIndex: -1 } });
		root.append(this.archivedHeading, this.body);
		this.contentElement.append(root);

		const actions = this.actions = this._register(instantiation.createInstance(ProjectsActions, {
			showDialog: (edit?: ChatProjectEdit) => {
				const pane = editors.activePane;
				if (!(pane instanceof ProjectsEditorPane) || !pane.isVisible()) return;
				const focused = getActiveElement(document);
				const row = this.focusedRow();
				pane.showProjectDialog(edit, () => {
					if (!this.isBodyVisible() || !this.element.getClientRects().length) return false;
					if (isHTMLElement(focused) && focused.isConnected && !focused.matches(':disabled')) {
						focused.focus();
					} else if (!edit) {
						this.toolbar.focusCreate();
					} else if (!this.restoreRowFocus(row)) {
						this.focus();
					}
					return true;
				});
			},
			focusList: () => this.focus(),
			isVisible: () => this.isBodyVisible(),
		}));
		this.headerActionsElement.classList.add('ash-projects-title-actions');
		this.toolbar = this._register(instantiation.createInstance(ProjectsToolbar, this.headerActionsElement, actions));
		this.list = this._register(instantiation.createInstance(ProjectsList, this.body, actions, () => this.isBodyVisible()));
		this._register(this.onDidChangeBodyVisibility(visible => {
			this.bodyVisible.set(visible, undefined);
			if (!visible) {
				actions.cancelPendingEdit();
				this.toolbar.closeSortMenu();
				this.list.reset();
			}
		}));

		const snapshots = derived(reader => catalog.sources.map(source => source.snapshot.read(reader)));
		const activeGroups = derived(reader => groupChatList(snapshots.read(reader), 'projects'));
		const archivedGroups = derived(reader => groupChatList(snapshots.read(reader), 'archived'));
		this._register(autorun(reader => {
			const visible = this.bodyVisible.read(reader);
			const state = projects.state.read(reader);
			this.toolbar.update(state, visible);
			if (!visible) return;

			const archived = this.showArchived.read(reader);
			this.archivedHeading.hidden = !archived;
			const focused = this.focusedRow();
			this.list.reset();
			this.content.clear();
			this.body.replaceChildren();
			this.body.setAttribute('aria-busy', String(state.loading));
			const query = state.query.trim().toLocaleLowerCase();
			if (archived) {
				this.list.renderArchivedProjects(state, archivedGroups.read(reader), query, this.content);
			} else {
				const localIds = new Set(state.projects.map(project => project.id));
				const groups = activeGroups.read(reader).filter(group => !localIds.has(group.key) && group.title.toLocaleLowerCase().includes(query));
				const local = projects.getProjects();
				if (local.length || groups.length) {
					this.list.renderCards(local, groups, this.content);
				} else if (state.loading && !state.projects.length) {
					this.body.append(h(document, 'p', { className: 'ash-projects-feedback loading', attributes: { role: 'status' } },
						localize('projects.loading', 'Loading projects…')));
					this.list.renderLoading();
				} else if (!state.message) {
					this.body.append(h(document, 'p', { className: 'ash-projects-view-status', attributes: { role: 'status' } }, query
						? localize('projects.noResults', 'No matching projects')
						: localize('projects.noProjects', 'No projects')));
				}
				this.list.updateSelection(state.selectedId ?? state.conversationProjectId);
			}
			if (state.message && !state.selectedId && !state.conversationProjectId) {
				this.body.append(h(document, 'p', { className: 'ash-projects-view-status', attributes: { role: 'status' } }, state.message));
				this.content.add(new Button(this.body, {
					...defaultButtonStyles, label: localize('projects.retry', 'Try again'), onClick: () => { void projects.reload(); },
				}));
			}
			if (focused && !this.restoreRowFocus(focused)) this.focus();
		}));

		const verbosity = AccessibilityVerbositySettingId.Projects;
		const hint = accessible.getOpenAriaHint(verbosity);
		if (hint) root.setAttribute('aria-description', hint);
		// The merged title actions can receive focus outside the pane's DOM subtree.
		for (const target of [this.element, this.headerActionsElement]) {
			this._register(contextKeys.createScoped(target)).createKey('sessionsProjectsSidebarFocused', true);
		}
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type, priority: 110, name: `sessionsProjectsSidebar.${type}`, when: ContextKeyExpr.has('sessionsProjectsSidebarFocused'),
				getProvider: () => {
					const focused = document.activeElement;
					if (!isHTMLElement(focused) || !this.hasFocus()) return undefined;
					const row = this.focusedRow();
					return new AccessibleContentProvider(AccessibleViewProviderId.Projects, { type }, () =>
						type === AccessibleViewType.View
							? [this.showArchived.get() ? archivedTitle : title, this.body.innerText].filter(Boolean).join('\n')
							: localize('projects.sidebarHelp', 'Use Tab to reach the project actions toolbar. Use Left and Right Arrow to move between Search projects, Sort projects and Create project. The selected sort order is saved for this profile. An empty search collapses when focus leaves it. Press Escape to clear search and return to its button. In the project list, use Up and Down Arrow, Home or End. Press Enter to open the selected project in the main area. Press Tab on a project to reach Pin and More Actions. Run Toggle Archived Projects in the Command Palette to switch between active and archived projects.'),
						() => {
							const searchField = focused.closest<HTMLElement>('.ash-toolbar-search-field');
							if (searchField?.inert) searchField.parentElement?.querySelector<HTMLButtonElement>(':scope > button')?.focus();
							else if (focused.isConnected) focused.focus();
							else if (!this.restoreRowFocus(row)) this.focus();
						}, verbosity);
				},
			}));
		}
	}

	createProject(): void {
		this.toolbar.focusCreate();
		this.actions.createProject();
	}

	toggleArchivedProjects(): void {
		const archived = !this.showArchived.get();
		this.showArchived.set(archived, undefined);
		if (archived) this.archivedHeading.focus();
		else this.focus();
	}

	override focus(): void {
		const state = this.projects.state.get();
		if (this.list.focusCard(state.selectedId ?? state.conversationProjectId) || this.list.focusCard()) return;
		if (state.busy) this.body.focus();
		else this.toolbar.focusCreate();
	}

	private focusedRow(): string | undefined {
		const focused = getActiveElement(this.body.ownerDocument);
		return isHTMLElement(focused) && this.body.contains(focused) ? focused.dataset.projectControl : undefined;
	}

	private restoreRowFocus(row: string | undefined): boolean {
		if (!row) return false;
		const replacement = Array.from(this.body.querySelectorAll<HTMLButtonElement>('[data-project-control]'))
			.find(node => node.dataset.projectControl === row && !node.disabled);
		replacement?.focus({ preventScroll: true });
		return !!replacement;
	}
}
