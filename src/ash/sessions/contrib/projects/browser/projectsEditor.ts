import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput, IEditorPane } from '../../../../workbench/common/editor.js';
import { addDisposableListener, getActiveElement, getWindow, h, isHTMLElement, type IDimension } from '../../../../base/browser/dom.js';
import { Button, type IButtonOptions } from '../../../../base/browser/ui/button/button.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, derived, observableValue } from '../../../../base/common/observable.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import type { Project } from '../../../../platform/projects/common/projectService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { getCatalogProjectRename, getProjectSessionRows, groupChatList, IChatListCatalog, type CatalogProjectDetails, type ChatListEntry, type ChatListGroup } from '../../chat/browser/chatListModel.js';
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
	private catalogHistoryKey: string | undefined;
	private catalogMaterialSnapshotKey: string | undefined;
	private catalogMaterialSyncKey: string | undefined;
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
		const details = selected?.project?.details;
		const renameCatalogProject = !details || details.data.read(reader)?.canEdit
			? getCatalogProjectRename(selected?.project?.editDetails)
			: undefined;
		return {
			kind: 'breadcrumb',
			name: selected?.title ?? project?.name ?? '',
			editor: this.domNode,
			loading,
			busy: state.busy,
			showSeparator: !!(selected || project || loading),
			catalogCurrent: !state.selectedId && !selected,
			rename: project
				? { id: project.id, save: name => this.projects.update(project, name, project.description, project.materials) }
				: selected && renameCatalogProject ? {
					id: details?.key ?? selected.key,
					save: async (name, signal) => {
						try {
							await renameCatalogProject(name, signal);
							return true;
						} catch (error) {
							if (!signal.aborted && !isCancellationError(error)) this.showError(toErrorMessage(error));
							return false;
						}
					},
				} : undefined,
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
		// Projects restores its catalogue even when the previous window closed in a detail view.
		this.domNode = h(document, 'section', {
			className: 'ash-projects',
			properties: { tabIndex: -1 },
			attributes: { 'aria-label': localize('projects.title', 'Projects') },
		});
		this.projectMaterials = this._register(
			this.instantiationService.createInstance(ProjectMaterials, this.domNode, (message: string) => this.showError(message)),
		);
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
		const refreshCatalogProject = () => {
			if (!this.shown.get() || document.visibilityState !== 'visible') return;
			const id = this.projects.state.get().conversationProjectId;
			const project = this.projectGroups.get().find(group => group.key === id)?.project;
			project?.refreshHistory?.();
			const details = project?.details;
			if (details?.load && !this.catalogDetailsRequest.value) this.loadCatalogDetails(details);
		};
		this._register(addDisposableListener(getWindow(this.domNode), 'focus', refreshCatalogProject));
		this._register(addDisposableListener(document, 'visibilitychange', refreshCatalogProject));
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
			const root = this.projectMaterials.fileRoot.read(reader);
			const shown = this.shown.read(reader);
			this.projectMaterials.setCatalogProject(shown ? details?.key : undefined, root);
			const loadedMaterials = shown && load?.key === details?.key && load?.phase === 'loaded'
				? data?.materials?.filter(file => file.kind === 'file') : undefined;
			// Chat state can reproject unchanged rows after another window has saved a newer list.
			const snapshotKey = details && loadedMaterials
				? JSON.stringify([details.key, loadedMaterials.map(file => [file.id, file.name])]) : undefined;
			if (snapshotKey !== this.catalogMaterialSnapshotKey) {
				this.catalogMaterialSnapshotKey = snapshotKey;
				if (details && loadedMaterials) this.projects.rememberCatalogMaterialNames(selected?.project?.preferenceKey ?? details.key, loadedMaterials);
			}
			const projectChats = state.selected
				? getProjectSessionRows(snapshots.flatMap(snapshot => snapshot.entries), state.selected.sessionIds, state.selected.externalConversationIds) : [];
			this.render(state, groups, selected, archived ? groupChatList(snapshots, 'archived') : undefined, projectChats, data, load?.key === details?.key ? load?.phase : undefined);
			const readableMaterials = loadedMaterials?.filter(file => file.read);
			const materialSyncKey = root && details && readableMaterials?.length
				? JSON.stringify([root.toString(), details.key, readableMaterials.map(file => [file.id, file.name])]) : undefined;
			if (materialSyncKey !== this.catalogMaterialSyncKey) {
				this.catalogMaterialSyncKey = materialSyncKey;
				if (root && details && readableMaterials?.length) {
					void this.projectMaterials.syncCatalog(readableMaterials);
				}
			}
			if (shown && details?.load && load?.key !== details.key) {
				this.projectActions.cancelPendingEdit();
				this.loadCatalogDetails(details);
			} else if (!details?.load && load) {
				this.catalogDetailsRequest.clear();
				this.catalogDetailsLoad.set(undefined);
				this.projectActions.cancelPendingEdit();
			}
			const project = (selected ?? groups.find(group => group.key === state.selectedId))?.project;
			const history = project?.history;
			const historyKey = shown && project?.refreshHistory ? project.preferenceKey ?? project.id : undefined;
			const refreshHistory = historyKey !== undefined && historyKey !== this.catalogHistoryKey;
			this.catalogHistoryKey = historyKey;
			if (shown && history?.state === 'idle') {
				history.load();
			} else if (refreshHistory) {
				project?.refreshHistory?.();
			}
		}));
	}

	public createProject(): void {
		this.projectActions.createProject();
	}

	private showProjectDialog(edit?: ChatProjectEdit): void {
		const instructionsProject = edit && 'instructionsOnly' in edit && edit.instructionsOnly
			? this.body.querySelector<HTMLElement>('[data-project-detail]')?.dataset.projectDetail
			: undefined;
		this.projectDialogs.showChatProjectDialog(this.domNode, () => {
			if (this.isDisposed || !this.isVisible()) return;
			if (instructionsProject) {
				const current = this.body.querySelector<HTMLElement>('[data-project-detail]');
				const trigger = current?.dataset.projectDetail === instructionsProject
					? current.querySelector<HTMLButtonElement>('[data-project-control="instructions"]')
					: undefined;
				if (trigger) {
					trigger.focus();
					return;
				}
			}
			this.focus();
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
		this.domNode.classList.toggle('stack-project-details', dimension.width < 840);
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
		if (!details.load) return;
		const controller = new AbortController();
		this.catalogDetailsRequest.value = toDisposable(() => controller.abort());
		const setPhase = (phase: 'loading' | 'loaded' | 'error') => {
			const current = this.catalogDetailsLoad.get();
			if (current?.key !== details.key || current.phase !== phase) this.catalogDetailsLoad.set({ key: details.key, phase });
		};
		const finish = (phase: 'loaded' | 'error') => {
			if (controller.signal.aborted) return;
			this.catalogDetailsRequest.clear();
			setPhase(phase);
		};
		const current = this.catalogDetailsLoad.get();
		if (current?.key !== details.key || current.phase !== 'loaded') setPhase('loading');
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
		const sameProject = detail !== null && detail.dataset.projectDetail === projectId;
		const overview = sameProject ? detail.querySelector<HTMLElement>('.ash-projects-overview') : undefined;
		const scroller = overview?.scrollTop ? overview : this.domNode;
		const scrollTop = overview ? scroller.scrollTop : 0;
		const viewportTop = scrollTop ? scroller.getBoundingClientRect().top : 0;
		const anchor = scrollTop && overview ? Array.from(overview.querySelectorAll<HTMLElement>('.ash-projects-conversation'))
			.find(row => row.getBoundingClientRect().bottom > viewportTop) : undefined;
		const anchorTop = anchor?.getBoundingClientRect().top;
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
			if (replacement) replacement.focus({ preventScroll: sameProject });
			else if (sameProject) this.domNode.focus({ preventScroll: true });
			else this.focusPage();
		}
		// Restore the visible row after rebuilding the list, including when new rows appear above it.
		if (scrollTop && overview) {
			const replacement = anchor && Array.from(overview.querySelectorAll<HTMLElement>('.ash-projects-conversation'))
				.find(row => row.dataset.projectControl === anchor.dataset.projectControl);
			scroller.scrollTop = replacement && anchorTop !== undefined
				? scroller.scrollTop + replacement.getBoundingClientRect().top - anchorTop : scrollTop;
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
		const details = conversationProject?.details;
		layout.dataset.projectDetail = id;
		layout.classList.toggle('with-detail-card', !!(localProject || details));
		const detailContent = layout.querySelector<HTMLElement>('.ash-projects-detail-content') ?? h(document, 'div', { className: 'ash-projects-detail-content' });
		const overview = layout.querySelector<HTMLElement>('.ash-projects-overview') ?? h(document, 'section', { className: 'ash-projects-overview' });
		overview.querySelector('.ash-projects-conversations')?.remove();
		this.projectList.renderConversations(overview, chats, conversationProject, this.content);
		if (overview.parentElement !== detailContent) detailContent.append(overview);
		if (detailContent.parentElement !== layout) layout.append(detailContent);
		this.renderProjectComposer(layout, id, localProject ? undefined : conversationProject?.composer, !!localProject);
		layout.querySelector('.ash-projects-detail-card')?.remove();
		if (localProject) {
			const isCurrent = () => this.shown.get() && this.projects.state.get().selectedId === id;
			detailContent.append(this.renderProjectDetailCard(localProject.description,
				() => this.showProjectDialog({ project: localProject, instructionsOnly: true }),
				target => this.projectMaterials.renderLocal(target, localProject, this.projects.state.get().busy, isCurrent, this.content)));
		} else if (details) {
			const failed = detailsPhase === 'error' || detailsPhase === 'loaded' && !data?.materials;
			const cachedNames = data?.materials === undefined
				? this.projects.readCatalogMaterialNames(conversationProject.preferenceKey ?? details.key) : undefined;
			const materialsSnapshot = data?.materials ?? cachedNames?.map(file => ({ ...file, kind: 'file' as const }));
			const editDetails = conversationProject?.editDetails;
			const card = this.renderProjectDetailCard(data?.description,
				data?.canEdit && editDetails ? () => { void this.projectActions.editConversationProject(editDetails, true); } : undefined,
				target => this.projectMaterials.renderCatalog(target, details.key, {
					rows: materialsSnapshot,
					upload: data?.canEdit && data.materials ? details.upload : undefined,
					isCurrent: () => this.shown.get() && this.projects.state.get().conversationProjectId === id
						&& this.projectGroups.get().find(group => group.key === id)?.project?.details?.key === details.key,
					status: !details.load ? undefined : failed ? {
						text: localize('projects.detailsLoadFailed', 'Could not load all project details.'), retry: () => this.loadCatalogDetails(details),
					} : materialsSnapshot ? undefined : { text: localize('projects.loadingDetails', 'Loading project details…') },
				}, this.content));
			card.dataset.catalogProjectMaterials = '';
			detailContent.append(card);
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

	private renderProjectDetailCard(
		description: string | undefined,
		edit: (() => void) | undefined,
		renderMaterials: (target: HTMLElement) => HTMLElement,
	): HTMLElement {
		const document = this.domNode.ownerDocument;
		const label = localize('projects.instructions', 'Instructions');
		const heading = h(
			document,
			'div',
			{ className: 'ash-projects-section-heading' },
			h(document, 'h2', {}, label),
		);
		if (edit) {
			const editLabel = description
				? localize('projects.editInstructions', 'Edit instructions')
				: localize('projects.addInstructions', 'Add instructions');
			this.button(heading, {
				label: editLabel,
				title: editLabel,
				icon: description ? Lxicon.edit : Lxicon.add,
				iconOnly: true,
				onClick: edit,
			}, 'instructions');
		}
		const guidance = h(document, 'section', {
			className: 'ash-projects-guidance', attributes: { 'aria-label': label },
		}, heading);
		if (description) {
			guidance.append(h(document, 'p', { className: 'ash-projects-description' }, description));
		} else if (description === '' && edit) {
			guidance.append(h(document, 'p', { className: 'ash-projects-muted' },
				localize('projects.noInstructions', 'Add instructions for this project.')));
		}
		const sections = h(document, 'div', { className: 'ash-projects-detail-sections' }, guidance);
		const card = h(document, 'div', { className: 'ash-projects-detail-card' }, sections);
		sections.append(renderMaterials(card));
		return card;
	}

	private renderDetailLoading(): void {
		const document = this.domNode.ownerDocument;
		const placeholder = (className = '') =>
			h(document, 'span', { className: `ash-projects-placeholder ${className}` });
		const skeleton = h(document, 'div', {
			className: 'ash-projects-skeleton ash-projects-detail with-detail-card',
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
				{ className: 'ash-projects-skeleton-lines' },
				placeholder(),
				placeholder(),
				placeholder('ash-projects-skeleton-short'),
			),
		);
		const card = h(
			document,
			'div',
			{ className: 'ash-projects-detail-card' },
			h(document, 'div', { className: 'ash-projects-guidance ash-projects-skeleton-lines' },
				placeholder('ash-projects-skeleton-section-title'), placeholder()),
			h(document, 'div', { className: 'ash-projects-materials ash-projects-skeleton-lines' },
				placeholder('ash-projects-skeleton-section-title'), placeholder(), placeholder('ash-projects-skeleton-short')),
		);
		skeleton.append(overview, card);
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
