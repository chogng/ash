import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput, IEditorPane } from '../../../../workbench/common/editor.js';
import { addDisposableListener, getActiveElement, h, isHTMLElement, type IDimension } from '../../../../base/browser/dom.js';
import { Button, type IButtonOptions } from '../../../../base/browser/ui/button/button.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, derived, observableValue } from '../../../../base/common/observable.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import type { Project } from '../../../../platform/projects/common/projectService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { getProjectSessionRows, groupChatList, IChatListCatalog, type CatalogProjectDetails, type ChatListEntry, type ChatListGroup } from '../../chat/browser/chatListModel.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IProjectsService, type ProjectsState } from './projectsService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ProjectChatInput } from './projectChatInput.js';
import { IProjectDialogService, type ChatProjectEdit } from './projectDialogService.js';
import { ProjectMaterials } from './projectMaterials.js';
import type { ProjectTitleBarContent } from './projectTitleBarWidget.js';
import { ProjectsActions } from './projectsActions.js';
import { ProjectsList } from './projectsList.js';
import { ProjectsView } from './projectsView.js';
import './projects.css';

/** Hosts the Projects overview and opened project details. */
export class ProjectsEditorPane extends EditorPane implements IEditorPane {
	public readonly id = 'sessions.editor.projects';
	public domNode!: HTMLElement;
	private readonly content = this._register(new DisposableStore());
	private projectMaterials!: ProjectMaterials;
	private projectList!: ProjectsList;
	private projectActions!: ProjectsActions;
	private projectsView!: ProjectsView;
	private body!: HTMLElement;
	private message!: HTMLElement;
	private retry!: Button;
	private readonly projectInputs = this._register(new DisposableMap<string, ProjectChatInput>());
	private readonly catalogDetailsRequest = this._register(new MutableDisposable());
	private readonly catalogDetailsLoad = observableValue<{ readonly key: string; readonly phase: 'loading' | 'loaded' | 'error'; } | undefined>(this, undefined);
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
				if (!projectId || !this.projectList.focusCard(projectId)) this.projectsView.focusCreate();
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
		@IProjectDialogService private readonly projectDialogs: IProjectDialogService,
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
		this._register(toDisposable(() => this.projectDialogs.close(this.domNode)));
		this._register(this.contextKeys.createScoped(this.domNode)).createKey('sessionsProjectsFocused', true);
		const main = h(document, 'div', { className: 'ash-projects-main' });
		this.projectActions = this._register(this.instantiationService.createInstance(ProjectsActions, {
			showDialog: (edit?: ChatProjectEdit) => this.showProjectDialog(edit),
			focusList: () => {
				if (!this.projectList.focusCard()) this.projectsView.focusCreate();
			},
			isVisible: () => this.isVisible(),
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
		this.projectsView = this._register(this.instantiationService.createInstance(ProjectsView, this.body, this.projectList, this.projectActions));
		main.append(this.projectsView.heading, feedback, this.body);
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
			const details = selected?.project?.details;
			const load = this.catalogDetailsLoad.read(reader);
			const data = details?.data.read(reader);
			const projectChats = state.selected
				? getProjectSessionRows(snapshots.flatMap(snapshot => snapshot.entries), state.selected.sessionIds, state.selected.externalConversationIds) : [];
			this.render(state, groups, selected, archived ? groupChatList(snapshots, 'archived') : undefined, projectChats, data, load?.key === details?.key ? load?.phase : undefined);
			if (this.shown.read(reader) && details && load?.key !== details.key) {
				this.projectActions.cancelPendingEdit();
				this.loadCatalogDetails(details);
			} else if (!details && load) {
				this.catalogDetailsRequest.clear();
				this.catalogDetailsLoad.set(undefined);
				this.projectActions.cancelPendingEdit();
			}
			const history = (selected ?? groups.find(group => group.key === state.selectedId))?.project?.history;
			if (this.isVisible() && history?.state === 'idle') {
				history.load();
			}
		}));
	}

	public createProject(): void {
		this.projectActions.createProject();
	}

	private showProjectDialog(edit?: ChatProjectEdit): void {
		this.projectDialogs.showChatProjectDialog(this.domNode, () => {
			if (!this.isDisposed && this.isVisible()) this.focus();
		}, edit);
	}

	public toggleArchivedProjects(): void {
		if (this.projectsView.heading.hidden) {
			this.showArchived.set(true, undefined);
			this.projects.showProjects();
		} else {
			this.showArchived.set(!this.showArchived.get(), undefined);
		}
		this.focusPage();
	}

	public override async setInput(_input: IResourceEditorInput, _signal: AbortSignal): Promise<void> { }
	public override clearInput(): void { }
	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.activeProjectInput?.setVisible(visible);
		if (!visible && this.activeProjectInput?.submitted) this.activeProjectInput = undefined;
		this.shown.set(visible, undefined);
		if (visible) {
			const state = this.projects.state.get();
			if (!state.loading) void this.projects.reload();
			const history = this.projectGroups.get().find(group => group.key === (state.conversationProjectId ?? state.selectedId))?.project?.history;
			if (history?.state === 'idle') history.load();
		} else {
			this.catalogDetailsRequest.clear();
			this.catalogDetailsLoad.set(undefined);
			this.projectList.stopUpdatingTimes();
			this.projectsView.closeSortMenu();
			this.projectActions.cancelPendingEdit();
			this.projectDialogs.close(this.domNode);
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
			this.projectsView.focusCreate();
		}
	}

	private focusPage(): void {
		if (this.projectsView.heading.hidden) {
			this.domNode.scrollTop = 0;
			this.domNode.focus();
		} else {
			this.projectsView.focusHeading();
		}
	}

	private loadCatalogDetails(details: CatalogProjectDetails): void {
		const controller = new AbortController();
		this.catalogDetailsRequest.value = toDisposable(() => controller.abort());
		this.catalogDetailsLoad.set({ key: details.key, phase: 'loading' });
		const finish = (phase: 'loaded' | 'error') => {
			if (!controller.signal.aborted) this.catalogDetailsLoad.set({ key: details.key, phase });
		};
		void details.load(controller.signal).then(() => finish('loaded'), () => finish('error'));
	}

	private render(state: ProjectsState, groups: readonly ChatListGroup[], selected: ChatListGroup | undefined, archived: readonly ChatListGroup[] | undefined, projectChats: readonly ChatListEntry[],
		data: ReturnType<CatalogProjectDetails['data']['get']>, detailsPhase: 'loading' | 'loaded' | 'error' | undefined): void {
		const loadingProject = !!state.selectedId && !state.selected && state.loading;
		const projectName = selected?.title ?? state.selected?.name;
		const projectId = selected?.key ?? state.selected?.id;
		// Metadata can refresh while the editor has a selection or an IME composition.
		// Keep the same detail DOM and composer in that case, replacing only its supporting content.
		const focused = getActiveElement(this.domNode.ownerDocument) as HTMLElement;
		const focusedInComposer = this.activeProjectInput?.element.contains(focused) ?? false;
		const focusKey = this.body.contains(focused) ? focused.dataset.projectControl : undefined;
		const detail = this.body.querySelector<HTMLElement>('.ash-projects-detail');
		this.projectList.stopUpdatingTimes();
		this.content.clear();
		const catalogInputs = new Set(groups.flatMap(group => group.project?.composer ? [group.project.composer.key] : []));
		for (const [key, input] of this.projectInputs) {
			if (!key.startsWith('local:') && !catalogInputs.has(key)) {
				if (this.activeProjectInput === input) this.activeProjectInput = undefined;
				this.projectInputs.deleteAndDispose(key);
			}
		}
		if (projectId === undefined || detail?.dataset.projectDetail !== projectId) this.body.replaceChildren();
		this.domNode.classList.toggle('project-detail-open', projectId !== undefined);
		this.domNode.setAttribute('aria-label', projectName ?? localize('projects.title', 'Projects'));
		this.message.textContent =
			state.message ?? (state.loading ? localize('projects.loading', 'Loading projects…') : '');
		this.message.parentElement!.hidden = !state.message && !state.loading;
		// Keep loading announcements available without adding a row that shifts the page.
		this.message.parentElement!.classList.toggle('loading', state.loading && !state.message);
		this.retry.domNode.hidden = !state.message;
		this.retry.enabled = !state.loading && !state.busy;
		this.body.setAttribute('aria-busy', String(state.loading));
		this.projectsView.render(state, !state.selectedId && !selected, groups, archived, this.content);
		if (projectId !== undefined) {
			const conversations = selected ?? groups.find(group => group.key === state.selectedId);
			this.renderProject(projectId, [...projectChats, ...(conversations?.rows ?? [])], conversations?.project, state.selected, data, detailsPhase);
		} else if (loadingProject) {
			this.renderDetailLoading();
		}
		if (projectId === undefined) {
			this.activeProjectInput?.setVisible(false);
			this.activeProjectInput = undefined;
		}
		if (focusKey && !focusedInComposer) {
			const replacement = Array.from(this.body.querySelectorAll<HTMLElement>('[data-project-control]')).find(
				node => node.dataset.projectControl === focusKey,
			);
			if (replacement) replacement.focus({ preventScroll: replacement.classList.contains('ash-projects-conversation') });
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

	private renderProject(id: string, chats: readonly ChatListEntry[], conversationProject: ChatListGroup['project'], localProject: Project | undefined,
		data: ReturnType<CatalogProjectDetails['data']['get']>, detailsPhase: 'loading' | 'loaded' | 'error' | undefined): void {
		const document = this.domNode.ownerDocument;
		const layout = this.body.querySelector<HTMLElement>('.ash-projects-detail') ?? h(document, 'div', { className: 'ash-projects-detail' });
		layout.dataset.projectDetail = id;
		const detailContent = layout.querySelector<HTMLElement>('.ash-projects-detail-content') ?? h(document, 'div', { className: 'ash-projects-detail-content' });
		const overview = layout.querySelector<HTMLElement>('.ash-projects-overview') ?? h(document, 'section', { className: 'ash-projects-overview' });
		overview.querySelector('.ash-projects-conversations')?.remove();
		this.projectList.renderConversations(overview, chats, conversationProject, this.content);
		if (overview.parentElement !== detailContent) detailContent.append(overview);
		if (detailContent.parentElement !== layout) layout.append(detailContent);
		this.renderProjectComposer(layout, id, localProject ? undefined : conversationProject?.composer, !!localProject);
		layout.querySelector('.ash-projects-materials')?.remove();
		const details = conversationProject?.details;
		if (localProject) {
			const materials = this.projectMaterials.renderLocal(document, localProject, this.projects.state.get().busy, this.content);
			this.renderProjectTools(detailContent, materials, localProject.description, () => this.showProjectDialog({ project: localProject }));
		} else if (details) {
			const failed = detailsPhase === 'error' || detailsPhase === 'loaded' && !data?.materials;
			const materials = this.projectMaterials.render(document, {
				rows: data?.materials,
				addFiles: data?.canEdit && data.materials ? details.addFiles : undefined,
				status: failed ? {
					text: localize('projects.detailsLoadFailed', 'Could not load all project details.'), retry: () => this.loadCatalogDetails(details),
				} : data ? undefined : { text: localize('projects.loadingDetails', 'Loading project details…') },
			}, this.content);
			materials.dataset.catalogProjectMaterials = '';
			const editDetails = conversationProject?.editDetails;
			this.renderProjectTools(detailContent, materials, data?.description,
				data?.canEdit && editDetails ? () => { void this.projectActions.editConversationProject(editDetails); } : undefined);
		}
		if (layout.parentElement !== this.body) this.body.append(layout);
	}

	private renderProjectComposer(layout: HTMLElement, id: string, composer: NonNullable<ChatListGroup['project']>['composer'], isLocal: boolean): void {
		if (!isLocal && !composer) {
			this.activeProjectInput?.setVisible(false);
			this.activeProjectInput = undefined;
			layout.querySelector('.ash-projects-composer')?.remove();
			return;
		}
		const key = composer?.key ?? `local:${id}`;
		let input = this.projectInputs.get(key);
		// Only start a fresh composer on return. A late project refresh must not
		// dispose a successful sender before its scheduled conversation navigation.
		if (!input || input.submitted && this.activeProjectInput !== input) {
			this.projectInputs.deleteAndDispose(key);
			input = this.instantiationService.createInstance(ProjectChatInput, layout.ownerDocument, composer ?? { projectId: id }, () => {
				if (this.activeProjectInput !== input) return;
				this.activeProjectInput = undefined;
				this.projectInputs.deleteAndDispose(key);
				if (isLocal) void this.projects.openProject(id);
				else this.projects.openConversationProject(id);
			}, () => this.isVisible() && this.activeProjectInput === input);
			this.projectInputs.set(key, input);
		}
		if (this.activeProjectInput !== input) this.activeProjectInput?.setVisible(false);
		this.activeProjectInput = input;
		if (input.element.parentElement !== layout) {
			layout.querySelector('.ash-projects-composer')?.remove();
			layout.append(input.element);
		}
		input.setVisible(this.isVisible());
	}

	private renderProjectTools(detailContent: HTMLElement, materials: HTMLElement, description: string | undefined, edit: (() => void) | undefined): void {
		const document = detailContent.ownerDocument;
		const heading = h(
			document,
			'div',
			{ className: 'ash-projects-section-heading' },
			h(document, 'h2', {}, localize('projects.goals', 'Project goals')),
		);
		if (edit) this.button(
			heading,
			{
				label: localize('projects.edit', 'Edit details'),
				icon: Lxicon.edit,
				onClick: edit,
			},
			'edit',
		);
		const goals = h(document, 'section', { className: 'ash-projects-goals' });
		goals.append(heading);
		if (description !== undefined) {
			goals.append(h(
				document,
				'p',
				{ className: 'ash-projects-description' },
				description || localize('projects.noGoals', 'Add a description of what you want to achieve.'),
			));
		}
		materials.append(goals);
		detailContent.append(materials);
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
