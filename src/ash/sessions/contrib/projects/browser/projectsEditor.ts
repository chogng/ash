import {
	defaultButtonStyles,
	defaultDialogStyles,
	defaultCheckboxStyles,
	defaultInputBoxStyles,
} from '../../../../platform/theme/browser/defaultStyles.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput, IEditorPane } from '../../../../workbench/common/editor.js';
import { addDisposableListener, getActiveElement, h, type IDimension } from '../../../../base/browser/dom.js';
import { Button, type IButtonOptions } from '../../../../base/browser/ui/button/button.js';
import {
	ButtonActionViewItem,
	type ActionViewItemOptions,
} from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { DropdownMenuActionViewItem } from '../../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Dialog, DialogContentsAlignment } from '../../../../base/browser/ui/dialog/dialog.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { AnchorAlignment, AnchorPosition } from '../../../../base/browser/ui/contextview/contextview.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import type { IAction } from '../../../../base/common/actions.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { autorun } from '../../../../base/common/observable.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { basename } from '../../../../base/common/resources.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { getNLSLanguage, localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import type { Project, ProjectMaterial, ProjectSummary } from '../../../../platform/projects/common/projectService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IProjectsService, type ProjectSortOrder, type ProjectsState } from './projectsService.js';
import { ISessionsTitlebarService } from '../../../browser/parts/titlebarPart.js';
import './projects.css';

/** Keeps the expanded input in the search action's slot and preserves text-editing keys. */
class ProjectsSearchActionViewItem extends ButtonActionViewItem {
	private field!: HTMLElement;
	private closeButton!: Button;
	private tabbable = false;

	constructor(
		action: IAction,
		options: ActionViewItemOptions,
		private readonly input: HTMLInputElement,
		private readonly closeSearch: () => void,
	) {
		super(action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('ash-projects-search-action');
		this.field = h(container.ownerDocument, 'div', {
			className: 'ash-projects-search-field',
			properties: { hidden: true },
		});
		const icon = h(container.ownerDocument, 'span', { attributes: { 'aria-hidden': 'true' } });
		appendIcon(Lxicon.search, icon);
		this.field.append(icon, this.input);
		this.closeButton = this.createButton(this.field, {
			label: localize('projects.closeSearch', 'Close project search'),
			icon: Lxicon.close,
			iconOnly: true,
			onClick: this.closeSearch,
		});
		container.append(this.field);
		this._register(
			addDisposableListener(this.field, 'focusout', event => {
				if (this.expanded && !this.input.value && !this.field.contains(event.relatedTarget as Node | null)) {
					// Collapse empty search without taking focus back from the user's next target.
					this.setExpanded(false);
				}
			}),
		);
		this._register(
			addDisposableListener(this.field, 'keydown', event => {
				if (event.key === 'Escape' && !event.isComposing) {
					event.preventDefault();
					event.stopPropagation();
					this.closeSearch();
				} else if (
					event.target === this.input &&
					['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)
				) {
					// The toolbar must not consume caret movement inside the search input.
					event.stopPropagation();
				}
			}),
		);
	}

	setExpanded(expanded: boolean): void {
		this.field.hidden = !expanded;
		// A closing field remains painted for its transition, but must stop accepting focus immediately.
		this.field.inert = !expanded;
		this.field.setAttribute('aria-hidden', String(!expanded));
		this.button.domNode.hidden = expanded;
		this.field.parentElement!.classList.toggle('expanded', expanded);
		this.setTabbable(this.tabbable);
	}

	get expanded(): boolean {
		return !this.field.hidden;
	}

	override setTabbable(tabbable: boolean): void {
		this.tabbable = tabbable;
		super.setTabbable(tabbable && !this.expanded);
		this.input.tabIndex = tabbable && this.expanded ? 0 : -1;
		this.closeButton.domNode.tabIndex = tabbable && this.expanded ? 0 : -1;
	}

	override focus(): void {
		if (this.expanded) {
			this.input.focus();
		} else {
			super.focus();
		}
	}
}

/** Projects own the front page. Material types appear only inside an opened project. */
export class ProjectsEditorPane extends EditorPane implements IEditorPane {
	public readonly id = 'sessions.editor.projects';
	public domNode!: HTMLElement;
	private readonly content = this._register(new DisposableStore());
	private readonly dialog = this._register(new MutableDisposable<DisposableStore>());
	private readonly titlebarContent = this._register(new MutableDisposable());
	private readonly relativeTimeUpdate = this._register(new IntervalTimer());
	private readonly relativeTime = new Intl.RelativeTimeFormat(getNLSLanguage(), { numeric: 'always' });
	private title!: HTMLElement;
	private breadcrumb!: HTMLElement;
	private breadcrumbProjects!: Button;
	private breadcrumbSeparator!: HTMLElement;
	private breadcrumbName!: HTMLElement;
	private search!: HTMLInputElement;
	private searchActionViewItem!: ProjectsSearchActionViewItem;
	private tools!: HTMLElement;
	private toolbar!: WorkbenchToolBar;
	private toolbarActions!: readonly IAction[];
	private body!: HTMLElement;
	private message!: HTMLElement;
	private retry!: Button;
	private createActionViewItem!: ButtonActionViewItem;
	private sortDropdown!: DropdownMenuActionViewItem;
	private sortMenuOpen = false;

	constructor(
		@IProjectsService private readonly projects: IProjectsService,
		@IFileDialogService private readonly files: IFileDialogService,
		@IEditorService private readonly editors: IEditorService,
		@IHoverService private readonly hover: IHoverService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@ISessionsTitlebarService private readonly titlebar: ISessionsTitlebarService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@IDialogService private readonly dialogs: IDialogService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super('sessions.editor.projects', themeService, storageService);
	}

	public override create(parent: HTMLElement): void {
		const document = parent.ownerDocument;
		this.domNode = h(document, 'section', {
			className: 'ash-projects',
			attributes: { 'aria-label': localize('projects.title', 'Projects') },
		});
		parent.append(this.domNode);
		super.create(this.domNode);
		this._register(this.contextKeys.createScoped(this.domNode)).createKey('sessionsProjectsFocused', true);
		const main = h(document, 'div', { className: 'ash-projects-main' });
		this.breadcrumb = h(document, 'nav', {
			className: 'ash-projects-breadcrumb',
			attributes: { 'aria-label': localize('projects.breadcrumb', 'Project navigation') },
		});
		this._register(this.contextKeys.createScoped(this.breadcrumb)).createKey('sessionsProjectsFocused', true);
		this.breadcrumbProjects = this._register(
			new Button(this.breadcrumb, {
				...defaultButtonStyles,
				label: localize('projects.title', 'Projects'),
				onClick: () => {
					this.projects.showProjects();
					this.createActionViewItem.focus();
				},
			}),
		);
		this.breadcrumbSeparator = h(
			document,
			'span',
			{ className: 'ash-projects-breadcrumb-separator', attributes: { 'aria-hidden': 'true' } },
			'/',
		);
		this.breadcrumbName = h(document, 'span', {
			className: 'ash-projects-breadcrumb-name',
			attributes: { 'aria-current': 'page' },
		});
		this.breadcrumb.append(this.breadcrumbSeparator, this.breadcrumbName);
		this._register(
			this.hover.setupDelayedHover(this.breadcrumbName, () => ({
				content: this.breadcrumbName.textContent ?? '',
			})),
		);
		const heading = h(document, 'header', { className: 'ash-projects-heading' });
		this.title = h(document, 'h1', { properties: { tabIndex: -1 } }, localize('projects.title', 'Projects'));
		this.search = h(document, 'input', {
			className: 'ash-projects-search',
			properties: { type: 'search', placeholder: localize('projects.search', 'Search projects') },
			attributes: { 'aria-label': localize('projects.search', 'Search projects') },
		});
		this.toolbar = this._register(
			new WorkbenchToolBar(heading, this.contextMenus, {
				ariaLabel: localize('projects.toolbar', 'Project actions'),
				actionViewItemProvider: (action, options) => {
					if (action.id === 'projects.search') {
						this.searchActionViewItem = new ProjectsSearchActionViewItem(
							action,
							options,
							this.search,
							() => {
								this.projects.setQuery('');
								this.setSearchVisible(false);
								this.searchActionViewItem.focus();
							},
						);
						return this.searchActionViewItem;
					}
					if (action.id === 'projects.sort') {
						const item = new DropdownMenuActionViewItem(
							action,
							() => this.getSortActions(),
							{
								showContextMenu: delegate =>
									this.contextMenus.showContextMenu({
										...delegate,
										anchorPosition: AnchorPosition.Below,
										getMenuClassName: () => 'ash-projects-sort-menu',
										getCheckedActionsRepresentation: () => 'radio',
										autoSelectFirstItem: true,
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
				id: 'projects.create',
				label: createLabel,
				tooltip: '',
				enabled: true,
				run: () => this.showProjectDialog(),
			},
		];
		this.toolbar.setActions(this.toolbarActions);
		heading.append(this.title, this.tools);
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
		main.append(heading, feedback, this.body);
		this.domNode.append(main);
		this._register(addDisposableListener(this.search, 'input', () => this.projects.setQuery(this.search.value)));
		this._register(addDisposableListener(this.body, 'keydown', event => this.navigateCards(event)));
		for (const container of [this.domNode, this.breadcrumb]) {
			this._register(
				addDisposableListener(container, 'focusin', event => {
					if (
						!this.domNode.contains(event.relatedTarget as Node) &&
						!this.breadcrumb.contains(event.relatedTarget as Node) &&
						this.configuration.getValue<boolean>(AccessibilityVerbositySettingId.Projects)
					) {
						status(localize('projects.helpHint', 'Press Alt+F1 for Projects accessibility help.'));
					}
				}),
			);
		}
		this._register(autorun(reader => this.render(this.projects.state.read(reader))));
	}

	public override async setInput(_input: IResourceEditorInput, _signal: AbortSignal): Promise<void> {}
	public override clearInput(): void {}
	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.updateTitlebar();
		if (visible) {
			void this.projects.reload();
		} else {
			this.relativeTimeUpdate.cancel();
			if (this.sortMenuOpen) {
				this.contextMenus.hideContextMenu();
			}
			this.dialog.clear();
		}
	}
	public override layout(dimension: IDimension): void {
		this.domNode.classList.toggle('narrow', dimension.width < 760);
	}
	public override focus(): void {
		this.projects.state.get().selectedId ? this.title.focus() : this.createActionViewItem.focus();
	}

	private updateTitlebar(): void {
		// The list has its own heading; only an opened project needs breadcrumb navigation.
		if (this.isVisible() && this.projects.state.get().selectedId) {
			this.titlebarContent.value ??= this.titlebar.setPageContent(this.breadcrumb);
		} else {
			this.titlebarContent.clear();
		}
	}

	private render(state: ProjectsState): void {
		if (state.selectedId && this.sortMenuOpen) {
			this.contextMenus.hideContextMenu();
		}
		const loadingProject = !!state.selectedId && !state.selected && state.loading;
		const focused = getActiveElement(this.domNode.ownerDocument) as HTMLElement;
		const focusKey = this.body.contains(focused) ? focused.dataset.projectControl : undefined;
		this.relativeTimeUpdate.cancel();
		this.content.clear();
		this.body.replaceChildren();
		this.breadcrumbSeparator.hidden = !state.selected && !loadingProject;
		this.breadcrumbName.hidden = !state.selected && !loadingProject;
		this.breadcrumbName.textContent = state.selected?.name ?? '';
		this.breadcrumbName.classList.toggle('ash-projects-placeholder', loadingProject);
		this.breadcrumbName.setAttribute('aria-hidden', String(loadingProject));
		if (state.selectedId) {
			this.breadcrumbProjects.domNode.removeAttribute('aria-current');
		} else {
			this.breadcrumbProjects.domNode.setAttribute('aria-current', 'page');
		}
		this.updateTitlebar();
		this.tools.hidden = !!state.selectedId;
		this.title.textContent = loadingProject ? '' : (state.selected?.name ?? localize('projects.title', 'Projects'));
		this.title.title = this.title.textContent;
		this.title.classList.toggle('ash-projects-placeholder', loadingProject);
		this.title.classList.toggle('ash-projects-loading-title', loadingProject);
		if (loadingProject) {
			this.title.setAttribute('aria-label', localize('projects.loading', 'Loading projects…'));
		} else {
			this.title.removeAttribute('aria-label');
		}
		this.setSearchVisible(!state.selectedId && (this.searchActionViewItem.expanded || !!state.query));
		this.search.value = state.query;
		const createAction = this.toolbarActions.find(action => action.id === 'projects.create')!;
		if (createAction.enabled === state.busy) {
			// Keep the search and dropdown items mounted while the primary action changes availability.
			this.toolbarActions = this.toolbarActions.map(action =>
				action === createAction ? { ...action, enabled: !state.busy } : action,
			);
			this.toolbar.setActions(this.toolbarActions);
		}
		this.message.textContent =
			state.message ?? (state.loading ? localize('projects.loading', 'Loading projects…') : '');
		this.message.parentElement!.hidden = !state.message && !state.loading;
		// Keep loading announcements available without adding a row that shifts the page.
		this.message.parentElement!.classList.toggle('loading', state.loading && !state.message);
		this.retry.domNode.hidden = !state.message;
		this.retry.enabled = !state.loading && !state.busy;
		this.body.setAttribute('aria-busy', String(state.loading));
		if (state.selected) {
			this.renderProject(state.selected);
		} else if (loadingProject) {
			this.renderLoading(true);
		} else if (!state.selectedId && this.projects.getProjects().length) {
			this.renderCards();
		} else if (state.loading) {
			this.renderLoading(false);
		} else if (!state.loading && !state.message) {
			this.renderEmpty(!!state.query);
		}
		if (focusKey) {
			(
				Array.from(this.body.querySelectorAll<HTMLElement>('[data-project-control]')).find(
					node => node.dataset.projectControl === focusKey,
				) ?? this.title
			).focus();
		}
	}

	private setSearchVisible(visible: boolean): void {
		this.searchActionViewItem.setExpanded(visible);
	}

	private getSortActions(): readonly IAction[] {
		const selected = this.projects.state.get().sortOrder;
		const options: readonly { order: ProjectSortOrder; label: string }[] = [
			{ order: 'updated', label: localize('projects.sortUpdated', 'Last updated') },
			{ order: 'created', label: localize('projects.sortCreated', 'Date created') },
			{ order: 'name', label: localize('projects.sortName', 'Alphabetical') },
		];
		return options.map(({ order, label }) => ({
			id: `projects.sort.${order}`,
			label,
			tooltip: label,
			enabled: true,
			checked: selected === order,
			run: () => {
				this.projects.setSortOrder(order);
			},
		}));
	}

	private focusProjectList(): void {
		const card = this.body.querySelector<HTMLElement>('.ash-projects-card');
		if (card) {
			card.focus();
		} else {
			this.createActionViewItem.focus();
		}
	}

	private button(parent: HTMLElement, options: IButtonOptions, key?: string): Button {
		const button = this.content.add(new Button(parent, { ...defaultButtonStyles, ...options }));
		if (key) {
			button.domNode.dataset.projectControl = key;
		}
		return button;
	}

	private renderEmpty(searching: boolean): void {
		const document = this.domNode.ownerDocument;
		const empty = h(document, 'div', { className: 'ash-projects-empty' });
		const illustration = h(
			document,
			'div',
			{ className: 'ash-projects-illustration', attributes: { 'aria-hidden': 'true' } },
			h(document, 'span'),
			h(document, 'span'),
			h(document, 'span'),
		);
		empty.append(
			illustration,
			h(
				document,
				'h2',
				{},
				searching
					? localize('projects.noResults', 'No matching projects')
					: localize('projects.emptyTitle', 'Looking to start a project?'),
			),
			h(
				document,
				'p',
				{},
				searching
					? localize('projects.searchHint', 'Try another name or clear your search.')
					: localize('projects.emptyDescription', 'Bring your materials and goals together in one space.'),
			),
		);
		this.button(empty, {
			label: searching
				? localize('projects.clearSearch', 'Clear search')
				: localize('projects.new', 'New project'),
			presentation: 'secondary',
			onClick: () => (searching ? this.projects.setQuery('') : this.showProjectDialog()),
		});
		this.body.append(empty);
	}

	private renderCards(): void {
		const document = this.domNode.ownerDocument;
		const list = h(document, 'ul', {
			className: 'ash-projects-grid',
			attributes: { 'aria-label': localize('projects.title', 'Projects') },
		});
		for (const project of this.projects.getProjects()) {
			const row = h(document, 'li', { className: 'ash-projects-row' });
			const card = h(document, 'button', {
				className: 'ash-button ash-button-quiet ash-projects-card',
				properties: { type: 'button' },
				attributes: { 'aria-label': project.name },
			});
			card.dataset.projectControl = project.id;
			const mark = h(document, 'span', {
				className: 'ash-projects-card-mark',
				attributes: { 'aria-hidden': 'true' },
			});
			appendIcon(Lxicon.projects, mark);
			const content = h(
				document,
				'span',
				{ className: 'ash-projects-card-content' },
				h(document, 'span', { className: 'ash-projects-card-name' }, project.name),
			);
			const timestamp = project.updatedAtMs ?? project.createdAtMs;
			if (timestamp !== undefined) {
				const date = new Date(timestamp);
				const updatedAt = localize('projects.updatedAt', 'Updated {0}', date.toLocaleString(getNLSLanguage()));
				const caption = h(document, 'time', {
					className: 'ash-projects-card-caption',
					properties: { dateTime: date.toISOString(), id: generateUuid() },
					attributes: { 'aria-label': updatedAt },
				});
				card.setAttribute('aria-describedby', caption.id);
				content.append(caption);
				this.content.add(this.hover.setupDelayedHover(caption, { content: updatedAt }));
			}
			card.append(mark, content);
			const actionsHost = h(document, 'div', { className: 'ash-projects-card-actions' });
			const pinned = this.projects.isPinned(project.id);
			const pinLabel = pinned
				? localize('projects.unpin', 'Unpin {0}', project.name)
				: localize('projects.pin', 'Pin {0}', project.name);
			const pin: IAction = {
				id: 'projects.pin',
				label: pinLabel,
				tooltip: pinLabel,
				icon: pinned ? Lxicon.pinFilled : Lxicon.pinned,
				enabled: !this.projects.state.get().busy,
				checked: pinned,
				run: () => this.projects.togglePinned(project.id),
			};
			const toolbar = this.content.add(
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
							// The menu mounts synchronously in this window; Projects owns its destructive styling.
							const destructiveAction = this.domNode.ownerDocument.querySelector(
								'.ash-projects-menu [data-action-id="projects.delete"]',
							);
							destructiveAction?.classList.add('ash-projects-destructive-action');
						},
					},
					{
						ariaLabel: localize('projects.actions', 'Actions for {0}', project.name),
						presentation: 'inherit-foreground',
						highlightToggledItems: false,
					},
				),
			);
			toolbar.setActions([], this.projectActions(project), [pin]);
			const pinButton = actionsHost.querySelector<HTMLElement>('[data-action-id="projects.pin"] button')!;
			pinButton.dataset.projectControl = `pin:${project.id}`;
			const moreButton = actionsHost.querySelector<HTMLElement>('.ash-toolbar-more-actions button')!;
			moreButton.dataset.projectControl = `more:${project.id}`;
			this.content.add(this.hover.setupDelayedHover(card, { content: project.name }));
			this.content.add(
				addDisposableListener(card, 'click', () => {
					void this.projects.openProject(project.id).then(() => this.title.focus());
				}),
			);
			row.append(card, actionsHost);
			list.append(row);
		}
		this.body.append(list);
		this.updateCardTimes();
		if (this.isVisible() && list.querySelector('time')) {
			this.relativeTimeUpdate.cancelAndSet(() => this.updateCardTimes(), 60_000, document.defaultView!);
		}
	}

	private updateCardTimes(): void {
		const now = Date.now();
		const units = [
			{ unit: 'year', milliseconds: 365 * 86_400_000 },
			{ unit: 'month', milliseconds: 30 * 86_400_000 },
			{ unit: 'day', milliseconds: 86_400_000 },
			{ unit: 'hour', milliseconds: 3_600_000 },
			{ unit: 'minute', milliseconds: 60_000 },
		] as const;
		// Refresh text in place so time passing never replaces cards or interrupts keyboard focus.
		for (const caption of this.body.querySelectorAll<HTMLTimeElement>('time.ash-projects-card-caption')) {
			const elapsed = Math.max(0, now - Date.parse(caption.dateTime));
			const unit = units.find(candidate => elapsed >= candidate.milliseconds);
			caption.textContent = unit
				? this.relativeTime.format(-Math.floor(elapsed / unit.milliseconds), unit.unit)
				: localize('projects.justNow', 'Just now');
		}
	}

	private projectActions(project: ProjectSummary): readonly IAction[] {
		const action = (id: string, label: string, icon: IAction['icon'], run: () => unknown): IAction => ({
			id,
			label,
			tooltip: label,
			icon,
			enabled: !this.projects.state.get().busy,
			run,
		});
		return [
			action('projects.edit', localize('projects.edit', 'Edit details'), Lxicon.edit, async () => {
				const current = await this.projects.readProject(project.id);
				if (current && !this.isDisposed && this.isVisible()) {
					this.showProjectDialog(current);
				}
			}),
			action('projects.archive', localize('projects.archive', 'Archive'), Lxicon.archive, async () => {
				await this.projects.archive(project);
				if (!this.isDisposed && this.isVisible()) {
					this.focusProjectList();
				}
			}),
			action('projects.delete', localize('projects.delete', 'Delete'), Lxicon.trash, async () => {
				const result = await this.dialogs.confirm({
					message: localize('projects.deleteConfirm', 'Delete project "{0}"?', project.name),
					detail: localize(
						'projects.deleteDetail',
						'The project and its material references will be removed. Conversations and source files will be kept.',
					),
					primaryButton: localize('projects.delete', 'Delete'),
				});
				if (result.confirmed) {
					await this.projects.remove(project);
					if (!this.isDisposed && this.isVisible()) {
						this.focusProjectList();
					}
				}
			}),
		];
	}

	private renderProject(project: Project): void {
		const document = this.domNode.ownerDocument;
		const layout = h(document, 'div', { className: 'ash-projects-detail' });
		const overview = h(document, 'section', { className: 'ash-projects-overview' });
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
				onClick: () => this.showProjectDialog(project),
			},
			'edit',
		);
		overview.append(
			heading,
			h(
				document,
				'p',
				{ className: 'ash-projects-description' },
				project.description || localize('projects.noGoals', 'Add a description of what you want to achieve.'),
			),
		);
		const materials = h(document, 'section', {
			className: 'ash-projects-materials',
			attributes: { 'aria-label': localize('projects.materials', 'Materials') },
		});
		const materialsHeading = h(
			document,
			'div',
			{ className: 'ash-projects-section-heading' },
			h(document, 'h2', {}, localize('projects.materials', 'Materials')),
		);
		this.button(
			materialsHeading,
			{
				label: localize('projects.addFiles', 'Add files'),
				icon: Lxicon.add,
				enabled: !this.projects.state.get().busy,
				onClick: () => {
					void this.addMaterials(project, 'file');
				},
			},
			'add-files',
		);
		materials.append(
			materialsHeading,
			h(
				document,
				'p',
				{ className: 'ash-projects-muted' },
				localize(
					'projects.materialsDescription',
					'Keep images, PDFs, documents and other files close at hand.',
				),
			),
		);
		if (!project.materials.length) {
			materials.append(
				h(
					document,
					'p',
					{ className: 'ash-projects-materials-empty' },
					localize('projects.noMaterials', 'Add your first material to this project.'),
				),
			);
		}
		const list = h(document, 'ul', { className: 'ash-projects-material-list' });
		for (const material of project.materials) {
			const row = h(document, 'li', { className: 'ash-projects-material' });
			const open = this.button(
				row,
				{
					label: material.name,
					icon: material.kind === 'folder' ? Lxicon.folders : Lxicon.file,
					onClick: () => {
						void this.openMaterial(material);
					},
				},
				material.resource.toString(),
			);
			this.content.add(this.hover.setupDelayedHover(open.domNode, { content: material.resource.fsPath }));
			this.button(
				row,
				{
					label: localize('projects.removeMaterial', 'Remove {0} from project', material.name),
					icon: Lxicon.close,
					iconOnly: true,
					enabled: !this.projects.state.get().busy,
					onClick: () => {
						void this.projects.update(
							project,
							project.name,
							project.description,
							project.materials.filter(item => item.resource.toString() !== material.resource.toString()),
						);
					},
				},
				`remove:${material.resource}`,
			);
			list.append(row);
		}
		materials.append(list);
		this.button(
			materials,
			{
				label: localize('projects.useFolder', 'Use a folder'),
				icon: Lxicon.folders,
				enabled: !this.projects.state.get().busy,
				onClick: () => {
					void this.addMaterials(project, 'folder');
				},
			},
			'add-folder',
		);
		materials.append(
			h(
				document,
				'p',
				{ className: 'ash-projects-source-note' },
				localize('projects.referenceHint', 'Files stay in their original location.'),
			),
		);
		layout.append(overview, materials);
		this.body.append(layout);
	}

	private renderLoading(detail: boolean): void {
		const document = this.domNode.ownerDocument;
		const placeholder = (className = '') =>
			h(document, 'span', { className: `ash-projects-placeholder ${className}` });
		const skeleton = h(document, 'div', {
			className: `ash-projects-skeleton ${detail ? 'ash-projects-detail' : 'ash-projects-grid'}`,
			attributes: { 'aria-hidden': 'true' },
		});
		if (detail) {
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
		} else {
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
		}
		this.body.append(skeleton);
	}

	private async addMaterials(project: Project, kind: ProjectMaterial['kind']): Promise<void> {
		try {
			const resources = await this.files.showOpenDialog({
				title: localize('projects.addMaterials', 'Add project materials'),
				canSelectFiles: kind === 'file',
				canSelectFolders: kind === 'folder',
				canSelectMany: true,
			});
			if (!resources || this.isDisposed) {
				return;
			}
			const materials = [...project.materials];
			for (const resource of resources) {
				if (!materials.some(item => item.resource.toString() === resource.toString())) {
					materials.push({ resource, name: basename(resource), kind });
				}
			}
			await this.projects.update(project, project.name, project.description, materials);
		} catch {
			this.showError(localize('projects.pickFailed', 'Could not add these materials. Try again.'));
		}
	}

	private async openMaterial(material: ProjectMaterial): Promise<void> {
		try {
			const resource =
				material.kind === 'folder'
					? (
							await this.files.showOpenDialog({
								defaultUri: material.resource,
								canSelectFiles: true,
								canSelectFolders: false,
							})
						)?.[0]
					: material.resource;
			if (resource && !this.isDisposed) {
				await this.editors.openEditor({ resource });
			}
		} catch {
			this.showError(
				localize(
					'projects.openFailed',
					'Could not open this material. Check that the source file is still available.',
				),
			);
		}
	}

	private showError(message: string): void {
		if (this.isDisposed) {
			return;
		}
		this.message.textContent = message;
		this.message.parentElement!.hidden = false;
		this.retry.domNode.hidden = true;
	}

	private showProjectDialog(project?: Project): void {
		if (this.dialog.value) {
			return;
		}
		const store = new DisposableStore();
		this.dialog.value = store;
		const document = this.domNode.ownerDocument;
		const previousFocus = getActiveElement(document);
		const form = h(document, 'form', { className: 'ash-projects-form' });
		const nameLabel = h(document, 'label', {}, localize('projects.nameLabel', 'What are you working on?'));
		const name = h(document, 'input', {
			properties: {
				type: 'text',
				value: project?.name ?? '',
				required: true,
				maxLength: 200,
				placeholder: localize('projects.namePlaceholder', 'Name your project'),
			},
		});
		nameLabel.append(name);
		const descriptionLabel = h(
			document,
			'label',
			{},
			localize('projects.descriptionLabel', 'What are you trying to achieve?'),
		);
		const description = h(document, 'textarea', {
			properties: {
				value: project?.description ?? '',
				maxLength: 20000,
				placeholder: localize('projects.descriptionPlaceholder', 'Describe your project, goals, subject, etc…'),
			},
		});
		descriptionLabel.append(description);
		let materials = [...(project?.materials ?? [])];
		let base = project;
		let needsMerge = false;
		const unresolved = new Set<HTMLInputElement | HTMLTextAreaElement>();
		const mergeControls = store.add(new DisposableStore());
		let chosenFolder: ProjectMaterial | undefined;
		const folderRow = h(document, 'div', { className: 'ash-projects-folder-choice' });
		const feedback = h(document, 'p', { className: 'ash-projects-form-error', attributes: { role: 'alert' } });
		const folder = store.add(
			new Button(folderRow, {
				...defaultButtonStyles,
				label: localize('projects.useFolder', 'Use a folder'),
				icon: Lxicon.newFolder,
				title: localize(
					'projects.useFolderTooltip',
					'Ash can work in this folder when you use the project from this computer.',
				),
				onClick: () => {
					void this.files
						.showOpenDialog({ canSelectFiles: false, canSelectFolders: true })
						.then(resources => {
							if (store.isDisposed || !resources?.[0]) {
								return;
							}
							const resource = resources[0];
							if (chosenFolder) {
								materials.splice(materials.indexOf(chosenFolder), 1);
								chosenFolder = undefined;
							}
							if (!materials.some(item => item.resource.toString() === resource.toString())) {
								chosenFolder = { resource, name: basename(resource), kind: 'folder' };
								materials.push(chosenFolder);
							}
							folder.label = basename(resource);
						})
						.catch(() => {
							if (!store.isDisposed) {
								feedback.textContent = localize(
									'projects.pickFailed',
									'Could not add these materials. Try again.',
								);
							}
						});
				},
			}),
		);
		const actions = h(document, 'footer', { className: 'ash-projects-form-actions' });
		const conflicts = h(document, 'div', { className: 'ash-projects-conflicts', properties: { hidden: true } });
		form.append(nameLabel, descriptionLabel, folderRow, feedback, conflicts, actions);
		let didSave = false;
		const dialog = store.add(
			new Dialog(
				this.domNode,
				project
					? localize('projects.edit', 'Edit details')
					: localize('projects.createTitle', 'Create a project'),
				[],
				{
					buttonStyles: defaultButtonStyles,
					checkboxStyles: defaultCheckboxStyles,
					inputBoxStyles: defaultInputBoxStyles,
					dialogStyles: defaultDialogStyles,
					type: 'none',
					alignment: DialogContentsAlignment.Vertical,
					extraClasses: ['ash-projects-dialog'],
					disableDefaultAction: true,
					renderBody: body => body.append(form),
				},
			),
		);
		const reload = store.add(
			new Button(actions, {
				...defaultButtonStyles,
				label: localize('projects.reloadMerge', 'Reload and merge'),
				presentation: 'secondary',
				onClick: () => {
					void reloadAndMerge();
				},
			}),
		);
		reload.domNode.hidden = true;
		store.add(
			new Button(actions, {
				...defaultButtonStyles,
				label: localize('projects.cancel', 'Cancel'),
				presentation: 'secondary',
				onClick: () => dialog.dispose(),
			}),
		);
		const submit = store.add(
			new Button(actions, {
				...defaultButtonStyles,
				label: project
					? localize('projects.save', 'Save changes')
					: localize('projects.create', 'Create project'),
				presentation: 'primary',
				type: 'submit',
				enabled: !!name.value.trim(),
			}),
		);
		const updateSubmit = () => {
			submit.enabled = !!name.value.trim() && !needsMerge && unresolved.size === 0;
		};
		store.add(addDisposableListener(name, 'input', updateSubmit));
		const offerMerge = (): boolean => {
			const latest = this.projects.state.get().projects.find(item => item.id === base?.id);
			if (!base || !latest || latest.revision === base.revision) {
				return false;
			}
			needsMerge = true;
			feedback.textContent = localize(
				'projects.editConflict',
				'This project changed in another window. Reload and merge to keep your draft and include the saved changes.',
			);
			reload.domNode.hidden = false;
			updateSubmit();
			reload.focus();
			return true;
		};
		const mergeField = (
			input: HTMLInputElement | HTMLTextAreaElement,
			previous: string,
			saved: string,
			label: string,
		): void => {
			let draft = input.value;
			if (draft.trim() === previous || draft.trim() === saved) {
				input.value = saved;
				return;
			}
			if (saved === previous) {
				return;
			}
			unresolved.add(input);
			const choiceLabel = h(document, 'label', {}, label);
			const choice = h(
				document,
				'select',
				{ attributes: { 'aria-label': label } },
				h(
					document,
					'option',
					{ properties: { value: '' } },
					localize('projects.chooseValue', 'Choose which value to keep'),
				),
				h(document, 'option', { properties: { value: 'draft' } }, localize('projects.keepDraft', 'Keep draft')),
				h(
					document,
					'option',
					{ properties: { value: 'saved' } },
					localize('projects.useSaved', 'Use saved value'),
				),
			);
			choiceLabel.append(
				h(
					document,
					'span',
					{ properties: { tabIndex: 0 } },
					localize('projects.savedValue', 'Saved value: {0}', saved),
				),
				choice,
			);
			conflicts.append(choiceLabel);
			mergeControls.add(
				addDisposableListener(input, 'input', () => {
					draft = input.value;
					choice.value = 'draft';
					unresolved.delete(input);
					updateSubmit();
				}),
			);
			mergeControls.add(
				addDisposableListener(choice, 'change', () => {
					if (!choice.value) {
						unresolved.add(input);
					} else {
						input.value = choice.value === 'saved' ? saved : draft;
						unresolved.delete(input);
					}
					updateSubmit();
				}),
			);
		};
		const reloadAndMerge = async (): Promise<void> => {
			if (!base || this.projects.state.get().busy) {
				return;
			}
			reload.enabled = false;
			name.disabled = true;
			description.disabled = true;
			folder.enabled = false;
			await this.projects.reload();
			if (store.isDisposed) {
				return;
			}
			const latest = await this.projects.readProject(base.id);
			if (store.isDisposed) {
				return;
			}
			const state = this.projects.state.get();
			if (state.message || latest?.id !== base.id) {
				feedback.textContent =
					state.message ?? localize('projects.loadFailed', 'Could not load projects. Try again.');
			} else {
				mergeControls.clear();
				conflicts.replaceChildren();
				unresolved.clear();
				mergeField(
					name,
					base.name,
					latest.name,
					localize('projects.nameConflict', 'The project name changed in both versions.'),
				);
				mergeField(
					description,
					base.description,
					latest.description,
					localize('projects.descriptionConflict', 'The project goals changed in both versions.'),
				);
				// The dialog only adds a folder. Start with the latest materials so a
				// concurrent addition or removal cannot be undone by the old draft.
				materials = [...latest.materials];
				if (
					chosenFolder &&
					!materials.some(item => item.resource.toString() === chosenFolder!.resource.toString())
				) {
					materials.push(chosenFolder);
				} else {
					chosenFolder = undefined;
				}
				base = latest;
				needsMerge = false;
				reload.domNode.hidden = true;
				conflicts.hidden = unresolved.size === 0;
				feedback.textContent = unresolved.size
					? localize(
							'projects.resolveConflict',
							'Your draft is preserved. Choose which value to keep for each conflict before saving.',
						)
					: localize(
							'projects.merged',
							'Saved changes and materials have been merged with your draft. Review and save the project.',
						);
			}
			reload.enabled = true;
			name.disabled = false;
			description.disabled = false;
			folder.enabled = true;
			updateSubmit();
			(conflicts.querySelector('select') ?? name).focus();
		};
		const id = generateUuid();
		store.add(
			addDisposableListener(form, 'submit', event => {
				event.preventDefault();
				if (
					!name.value.trim() ||
					this.projects.state.get().busy ||
					needsMerge ||
					unresolved.size ||
					offerMerge()
				) {
					return;
				}
				submit.enabled = false;
				name.disabled = true;
				description.disabled = true;
				folder.enabled = false;
				const result = base
					? this.projects.update(base, name.value.trim(), description.value.trim(), materials)
					: this.projects.create(id, name.value.trim(), description.value.trim(), materials);
				void result.then(saved => {
					if (store.isDisposed) {
						return;
					}
					if (saved) {
						didSave = true;
						dialog.dispose();
					} else {
						feedback.textContent = this.projects.state.get().message ?? '';
						name.disabled = false;
						description.disabled = false;
						folder.enabled = true;
						updateSubmit();
						offerMerge();
					}
				});
			}),
		);
		void dialog.show().then(() => {
			if (this.dialog.value === store) {
				this.dialog.clear();
			}
			// Updating action availability can replace the toolbar trigger during a save attempt.
			if (!this.isDisposed && this.isVisible() && (didSave || !previousFocus?.isConnected)) {
				this.focus();
			}
		});
		name.focus();
	}

	private navigateCards(event: KeyboardEvent): void {
		if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
			return;
		}
		const cards = Array.from(this.body.querySelectorAll<HTMLButtonElement>('.ash-projects-card'));
		const index = cards.indexOf(getActiveElement(this.domNode.ownerDocument) as HTMLButtonElement);
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
