import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput, IEditorPane } from '../../../../workbench/common/editor.js';
import { addDisposableListener, getActiveElement, h, isHTMLElement, type IDimension } from '../../../../base/browser/dom.js';
import { Button, type IButtonOptions } from '../../../../base/browser/ui/button/button.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun, derived, observableValue } from '../../../../base/common/observable.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import type { Project } from '../../../../platform/projects/common/projectService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { getProjectSessionRows, groupChatList, IChatListCatalog, type ChatListEntry, type ChatListGroup, type ConversationProjectEditor } from '../../chat/browser/chatListModel.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IProjectsService, type ProjectsState } from './projectsService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ProjectChatInput } from './projectChatInput.js';
import { ProjectDialog } from './projectDialog.js';
import { ProjectMaterials } from './projectMaterials.js';
import type { ProjectTitleBarContent } from './projectTitleBarWidget.js';
import { ProjectsActions } from './projectsActions.js';
import { ProjectsList } from './projectsList.js';
import { ProjectsToolbar } from './projectsToolbar.js';
import './projects.css';

/** Projects own the front page. Material types appear only inside an opened project. */
export class ProjectsEditorPane extends EditorPane implements IEditorPane {
	public readonly id = 'sessions.editor.projects';
	public domNode!: HTMLElement;
	private readonly content = this._register(new DisposableStore());
	private projectDialog!: ProjectDialog;
	private catalogHeading!: HTMLElement;
	private catalogTitle!: HTMLElement;
	private projectMaterials!: ProjectMaterials;
	private projectList!: ProjectsList;
	private projectActions!: ProjectsActions;
	private projectToolbar!: ProjectsToolbar;
	private body!: HTMLElement;
	private message!: HTMLElement;
	private retry!: Button;
	private readonly projectInputs = this._register(new DisposableMap<string, ProjectChatInput>());
	private activeProjectInput: ProjectChatInput | undefined;
	private readonly conversationProjects = derived(reader =>
		this.chatCatalog.sources.map(source => source.snapshot.read(reader)));
	private readonly projectGroups = derived(reader => groupChatList(this.conversationProjects.read(reader), 'projects'));
	private readonly shown = observableValue(this, false);
	private readonly showArchived = observableValue(this, false);
	readonly projectTitleBarContent = derived<ProjectTitleBarContent | undefined>(reader => {
		if (!this.shown.read(reader)) return undefined;
		const state = this.projects.state.read(reader);
		if (state.selectedId === undefined && state.conversationProjectId === undefined) return undefined;
		const selected = this.projectGroups.read(reader).find(group => group.key === state.conversationProjectId);
		const project = state.selected;
		const loading = !!state.selectedId && !project && state.loading;
		return {
			kind: 'breadcrumb',
			name: selected?.title ?? project?.name ?? '',
			editor: this.domNode,
			loading,
			busy: state.busy,
			showSeparator: !!(selected || project || loading),
			catalogCurrent: !state.selectedId && !selected,
			rename: project && { id: project.id, save: name => this.projects.update(project, name, project.description, project.materials) },
			open: () => {
				const projectId = this.projects.state.get().conversationProjectId;
				this.projects.showProjects();
				if (!projectId || !this.projectList.focusCard(projectId)) this.projectToolbar.focusCreate();
			},
		};
	});

	constructor(
		@IProjectsService private readonly projects: IProjectsService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatListCatalog private readonly chatCatalog: IChatListCatalog,
	) {
		super('sessions.editor.projects', themeService, storageService);
	}

	public override create(parent: HTMLElement): void {
		const document = parent.ownerDocument;
		this.projectMaterials = this._register(
			this.instantiationService.createInstance(ProjectMaterials, (message: string) => this.showError(message)),
		);
		// Projects restores its catalogue even when the previous window closed in a detail view.
		this.domNode = h(document, 'section', {
			className: 'ash-projects',
			properties: { tabIndex: -1 },
			attributes: { 'aria-label': localize('projects.title', 'Projects') },
		});
		parent.append(this.domNode);
		super.create(this.domNode);
		this.projectDialog = this._register(this.instantiationService.createInstance(ProjectDialog, this.domNode, () => {
			if (!this.isDisposed && this.isVisible()) this.focus();
		}));
		this._register(this.contextKeys.createScoped(this.domNode)).createKey('sessionsProjectsFocused', true);
		const main = h(document, 'div', { className: 'ash-projects-main' });
		this.catalogHeading = h(document, 'header', { className: 'ash-projects-heading' });
		this.catalogTitle = h(document, 'h1', { properties: { tabIndex: -1 } }, localize('projects.title', 'Projects'));
		this.catalogHeading.append(this.catalogTitle);
		this.projectActions = this._register(this.instantiationService.createInstance(ProjectsActions, {
			showDialog: (project?: Project, conversation?: ConversationProjectEditor) => this.projectDialog.show(project, conversation),
			focusList: () => {
				if (!this.projectList.focusCard()) this.projectToolbar.focusCreate();
			},
			isVisible: () => this.isVisible(),
		}));
		this.projectToolbar = this._register(this.instantiationService.createInstance(ProjectsToolbar, this.catalogHeading, this.projectActions, () => {
			this.showArchived.set(!this.showArchived.get(), undefined);
			this.catalogTitle.focus();
		}));
		const feedback = h(document, 'div', { className: 'ash-projects-feedback' });
		this.message = h(document, 'p', { attributes: { role: 'status', 'aria-live': 'polite' } });
		this.retry = this._register(
			new Button(feedback, {
				...defaultButtonStyles,
				label: localize('projects.retry', 'Try again'),
				onClick: () => {
					void this.projects.reload();
				},
			}),
		);
		feedback.prepend(this.message);
		this.body = h(document, 'div', { className: 'ash-projects-body' });
		this.projectList = this._register(this.instantiationService.createInstance(ProjectsList, this.body, this.projectActions, {
			openedProject: () => this.focusPage(),
			isVisible: () => this.isVisible(),
		}));
		main.append(this.catalogHeading, feedback, this.body);
		this.domNode.append(main);
		this._register(addDisposableListener(this.domNode, 'focusin', event => {
			const from = event.relatedTarget;
			if (isHTMLElement(from) && (this.domNode.contains(from) || from.closest('.ash-projects-breadcrumb'))) return;
			if (this.configuration.getValue<boolean>(AccessibilityVerbositySettingId.Projects)) {
				status(localize('projects.helpHint', 'Press Alt+F1 for Projects accessibility help.'));
			}
		}));
		this._register(autorun(reader => {
			const state = this.projects.state.read(reader);
			const id = state.conversationProjectId;
			const snapshots = this.conversationProjects.read(reader);
			const groups = this.projectGroups.read(reader);
			const archived = this.showArchived.read(reader) && !id && !state.selectedId;
			const selected = groups.find(group => group.key === id);
			const projectChats = state.selected?.sessionIds.length
				? getProjectSessionRows(snapshots.flatMap(snapshot => snapshot.entries), state.selected.sessionIds) : [];
			this.render(state, groups, selected, archived ? groupChatList(snapshots, 'archived') : undefined, projectChats);
			const history = (selected ?? groups.find(group => group.key === state.selectedId))?.project?.history;
			if (this.isVisible() && history?.state === 'idle') {
				history.load();
			}
		}));
	}

	public createProject(): void {
		this.projectActions.createProject();
	}

	public override async setInput(_input: IResourceEditorInput, _signal: AbortSignal): Promise<void> { }
	public override clearInput(): void { }
	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.activeProjectInput?.setVisible(visible);
		if (!visible && this.activeProjectInput?.submitted) this.activeProjectInput = undefined;
		this.shown.set(visible, undefined);
		if (visible) {
			void this.projects.reload();
			const history = this.projectGroups.get().find(group => group.key === (this.projects.state.get().conversationProjectId ?? this.projects.state.get().selectedId))?.project?.history;
			if (history?.state === 'idle') history.load();
		} else {
			this.projectList.stopUpdatingTimes();
			this.projectToolbar.closeSortMenu();
			this.projectActions.cancelPendingEdit();
			this.projectDialog.close();
		}
	}
	public override layout(dimension: IDimension): void {
		this.domNode.classList.toggle('narrow', dimension.width < 760);
	}
	public override focus(): void {
		if (this.projects.state.get().selectedId || this.projects.state.get().conversationProjectId !== undefined) {
			if (this.activeProjectInput) this.activeProjectInput.focus();
			else this.focusPage();
		} else {
			this.projectToolbar.focusCreate();
		}
	}

	private focusPage(): void {
		if (this.catalogHeading.hidden) {
			this.domNode.scrollTop = 0;
			this.domNode.focus();
		} else {
			this.catalogTitle.focus();
		}
	}

	private render(state: ProjectsState, groups: readonly ChatListGroup[], selected: ChatListGroup | undefined, archived: readonly ChatListGroup[] | undefined, projectChats: readonly ChatListEntry[]): void {
		const loadingProject = !!state.selectedId && !state.selected && state.loading;
		const projectName = selected?.title ?? state.selected?.name;
		// Metadata can refresh while the editor has a selection or an IME composition.
		// Keep the same detail DOM and composer in that case, replacing only its supporting content.
		const retainedInput = this.activeProjectInput;
		const retainDetail = !!state.selected && retainedInput === this.projectInputs.get(state.selected.id)
			&& this.body.querySelector('.ash-projects-detail:not(.ash-projects-skeleton)') !== null;
		const focusedInComposer = retainedInput?.element.contains(getActiveElement(this.domNode.ownerDocument)) ?? false;
		if (state.selectedId) this.projectToolbar.closeSortMenu();
		const focused = getActiveElement(this.domNode.ownerDocument) as HTMLElement;
		const focusKey = this.body.contains(focused) ? focused.dataset.projectControl : undefined;
		this.projectList.stopUpdatingTimes();
		this.content.clear();
		if (!retainDetail) this.body.replaceChildren();
		const projectsTitle = localize('projects.title', 'Projects');
		const catalogTitle = archived ? localize('projects.archived', 'Archived') : projectsTitle;
		this.catalogHeading.hidden = !!state.selectedId || !!selected;
		this.catalogTitle.textContent = catalogTitle;
		this.catalogTitle.title = catalogTitle;
		this.domNode.setAttribute('aria-label', projectName ?? projectsTitle);
		this.projectToolbar.update(state, !this.catalogHeading.hidden, !!archived);
		this.message.textContent =
			state.message ?? (state.loading ? localize('projects.loading', 'Loading projects…') : '');
		this.message.parentElement!.hidden = !state.message && !state.loading;
		// Keep loading announcements available without adding a row that shifts the page.
		this.message.parentElement!.classList.toggle('loading', state.loading && !state.message);
		this.retry.domNode.hidden = !state.message;
		this.retry.enabled = !state.loading && !state.busy;
		this.body.setAttribute('aria-busy', String(state.loading));
		if (selected) {
			this.projectList.renderConversations(this.body, selected.rows, selected.project, this.content);
		} else if (state.selected) {
			const conversations = groups.find(group => group.key === state.selectedId);
			this.renderProject(state.selected, [...projectChats, ...(conversations?.rows ?? [])], conversations?.project);
		} else if (loadingProject) {
			this.renderDetailLoading();
		} else {
			this.projectList.renderCatalog(state, groups, archived, this.content);
		}
		if (!state.selected) {
			this.activeProjectInput?.setVisible(false);
			this.activeProjectInput = undefined;
		}
		if (focusKey && !focusedInComposer) {
			const replacement = Array.from(this.body.querySelectorAll<HTMLElement>('[data-project-control]')).find(
				node => node.dataset.projectControl === focusKey,
			);
			if (replacement) replacement.focus();
			else this.focusPage();
		}
	}

	private button(parent: HTMLElement, options: IButtonOptions, key?: string): Button {
		const button = this.content.add(new Button(parent, { ...defaultButtonStyles, ...options }));
		if (key) {
			button.domNode.dataset.projectControl = key;
		}
		return button;
	}

	private renderProject(project: Project, chats: readonly ChatListEntry[], conversationProject: ChatListGroup['project']): void {
		const document = this.domNode.ownerDocument;
		const layout = this.body.querySelector<HTMLElement>('.ash-projects-detail:not(.ash-projects-skeleton)') ?? h(document, 'div', { className: 'ash-projects-detail' });
		const overview = layout.querySelector<HTMLElement>('.ash-projects-overview') ?? h(document, 'section', { className: 'ash-projects-overview' });
		let input = this.projectInputs.get(project.id);
		// Only start a fresh composer on return. A late project refresh must not
		// dispose a successful sender before its scheduled conversation navigation.
		if (!input || input.submitted && this.activeProjectInput !== input) {
			this.projectInputs.deleteAndDispose(project.id);
			input = this.instantiationService.createInstance(ProjectChatInput, document, project.id);
			this.projectInputs.set(project.id, input);
		}
		if (this.activeProjectInput !== input) this.activeProjectInput?.setVisible(false);
		this.activeProjectInput = input;
		if (!overview.contains(input.element)) overview.replaceChildren(input.element);
		input.setVisible(this.isVisible());
		overview.querySelector('.ash-projects-conversations')?.remove();
		this.projectList.renderConversations(overview, chats, conversationProject, this.content);
		const heading = h(
			document,
			'div',
			{ className: 'ash-projects-section-heading' },
			h(document, 'h2', {}, localize('projects.goals', 'Project goals')),
		);
		this.button(
			heading,
			{
				label: localize('projects.edit', 'Edit details'),
				icon: Lxicon.edit,
				onClick: () => this.projectDialog.show(project),
			},
			'edit',
		);
		const goals = h(document, 'section', { className: 'ash-projects-goals' });
		goals.append(
			heading,
			h(
				document,
				'p',
				{ className: 'ash-projects-description' },
				project.description || localize('projects.noGoals', 'Add a description of what you want to achieve.'),
			),
		);
		layout.querySelector('.ash-projects-materials')?.remove();
		const materials = this.projectMaterials.render(document, project, this.projects.state.get().busy, this.content);
		materials.append(goals);
		if (overview.parentElement !== layout) layout.append(overview);
		layout.append(materials);
		if (layout.parentElement !== this.body) this.body.append(layout);
	}

	private renderDetailLoading(): void {
		const document = this.domNode.ownerDocument;
		const placeholder = (className = '') =>
			h(document, 'span', { className: `ash-projects-placeholder ${className}` });
		const skeleton = h(document, 'div', {
			className: 'ash-projects-skeleton ash-projects-detail',
			attributes: { 'aria-hidden': 'true' },
		});
		const overview = h(
			document,
			'div',
			{ className: 'ash-projects-overview' },
			placeholder('ash-projects-skeleton-section-title'),
			h(
				document,
				'div',
				{ className: 'ash-projects-description ash-projects-skeleton-lines' },
				placeholder(),
				placeholder(),
				placeholder('ash-projects-skeleton-short'),
			),
		);
		const materials = h(
			document,
			'div',
			{ className: 'ash-projects-materials' },
			placeholder('ash-projects-skeleton-section-title'),
			h(
				document,
				'div',
				{ className: 'ash-projects-skeleton-lines' },
				placeholder(),
				placeholder('ash-projects-skeleton-short'),
			),
		);
		skeleton.append(overview, materials);
		this.body.append(skeleton);
	}

	private showError(message: string): void {
		if (this.isDisposed) {
			return;
		}
		this.message.textContent = message;
		this.message.parentElement!.hidden = false;
		this.retry.domNode.hidden = true;
	}
}
