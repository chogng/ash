import { defaultButtonStyles, defaultDialogStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput, IEditorPane } from '../../../../workbench/common/editor.js';
import { addDisposableListener, getActiveElement, h, type IDimension } from '../../../../base/browser/dom.js';
import { Button, type IButtonOptions } from '../../../../base/browser/ui/button/button.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { basename } from '../../../../base/common/resources.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import type { Project, ProjectMaterial } from '../../../../platform/projects/common/projectService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { ILibraryService, type LibraryState } from './libraryService.js';
import './library.css';

const projectButtonStyles = {
	...defaultButtonStyles,
	buttonBackground: 'var(--ash-foreground)',
	buttonForeground: 'var(--ash-editor-background)',
	buttonHoverBackground: 'var(--ash-description-foreground)',
	buttonSecondaryBackground: 'var(--ash-editor-background)',
};

/** Projects own the front page. Material types appear only inside an opened project. */
export class LibraryEditorPane extends EditorPane implements IEditorPane {
	public readonly id = 'sessions.editor.library';
	public domNode!: HTMLElement;
	private readonly content = this._register(new DisposableStore());
	private readonly dialog = this._register(new MutableDisposable<DisposableStore>());
	private title!: HTMLElement;
	private breadcrumb!: HTMLElement;
	private search!: HTMLInputElement;
	private tools!: HTMLElement;
	private body!: HTMLElement;
	private message!: HTMLElement;
	private retry!: Button;
	private createButton!: Button;
	private sort!: Button;

	constructor(
		@ILibraryService private readonly library: ILibraryService,
		@IFileDialogService private readonly files: IFileDialogService,
		@IEditorService private readonly editors: IEditorService,
		@IHoverService private readonly hover: IHoverService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) { super('sessions.editor.library', themeService, storageService); }

	public override create(parent: HTMLElement): void {
		const document = parent.ownerDocument;
		this.domNode = h(document, 'section', { className: 'ash-projects', attributes: { 'aria-label': localize('projects.title', 'Projects') } });
		parent.append(this.domNode);
		super.create(this.domNode);
		this._register(this.contextKeys.createScoped(this.domNode)).createKey('sessionsLibraryFocused', true);
		const main = h(document, 'div', { className: 'ash-projects-main' });
		this.breadcrumb = h(document, 'nav', { className: 'ash-projects-breadcrumb', attributes: { 'aria-label': localize('projects.breadcrumb', 'Project navigation') } });
		this._register(new Button(this.breadcrumb, { ...projectButtonStyles, label: localize('projects.title', 'Projects'), icon: Lxicon.arrowLeft, onClick: () => { this.library.showProjects(); this.createButton.focus(); } }));
		const heading = h(document, 'header', { className: 'ash-projects-heading' });
		this.title = h(document, 'h1', { properties: { tabIndex: -1 } }, localize('projects.title', 'Projects'));
		this.tools = h(document, 'div', { className: 'ash-projects-tools' });
		this.search = h(document, 'input', { className: 'ash-projects-search', properties: { type: 'search', placeholder: localize('projects.search', 'Search projects'), hidden: true }, attributes: { 'aria-label': localize('projects.search', 'Search projects') } });
		this._register(new Button(this.tools, { ...projectButtonStyles, label: localize('projects.search', 'Search projects'), icon: Lxicon.search, iconOnly: true, onClick: () => { this.search.hidden = !this.search.hidden; if (!this.search.hidden) { this.search.focus(); } } }));
		this.sort = this._register(new Button(this.tools, { ...projectButtonStyles, label: localize('projects.sort', 'Reverse alphabetical order'), icon: Lxicon.sortPrecedence, iconOnly: true, onClick: () => this.library.toggleSort() }));
		this.createButton = this._register(new Button(this.tools, { ...projectButtonStyles, label: localize('projects.new', 'New project'), presentation: 'primary', onClick: () => this.showProjectDialog() }));
		heading.append(this.title, this.tools);
		const feedback = h(document, 'div', { className: 'ash-projects-feedback' });
		this.message = h(document, 'p', { attributes: { role: 'status', 'aria-live': 'polite' } });
		this.retry = this._register(new Button(feedback, { ...projectButtonStyles, label: localize('projects.retry', 'Try again'), onClick: () => { void this.library.reload(); } }));
		feedback.prepend(this.message);
		this.body = h(document, 'div', { className: 'ash-projects-body' });
		main.append(this.breadcrumb, heading, this.search, feedback, this.body);
		this.domNode.append(main);
		this._register(addDisposableListener(this.search, 'input', () => this.library.setQuery(this.search.value)));
		this._register(addDisposableListener(this.body, 'keydown', event => this.navigateCards(event)));
		this._register(addDisposableListener(this.domNode, 'focusin', event => {
			if (!this.domNode.contains(event.relatedTarget as Node) && this.configuration.getValue<boolean>(AccessibilityVerbositySettingId.Library)) {
				status(localize('projects.helpHint', 'Press Alt+F1 for Projects accessibility help.'));
			}
		}));
		this._register(autorun(reader => this.render(this.library.state.read(reader))));
	}

	public override async setInput(_input: IResourceEditorInput, _signal: AbortSignal): Promise<void> { }
	public override clearInput(): void { }
	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (visible) { void this.library.reload(); }
		else { this.dialog.clear(); }
	}
	public override layout(dimension: IDimension): void { this.domNode.classList.toggle('narrow', dimension.width < 760); }
	public override focus(): void { this.library.state.get().selectedId ? this.title.focus() : this.createButton.focus(); }

	private render(state: LibraryState): void {
		const focused = getActiveElement(this.domNode.ownerDocument) as HTMLElement;
		const focusKey = this.body.contains(focused) ? focused.dataset.projectControl : undefined;
		this.content.clear();
		this.body.replaceChildren();
		this.breadcrumb.hidden = !state.selectedId;
		this.tools.hidden = !!state.selectedId;
		this.title.textContent = state.selected?.name ?? localize('projects.title', 'Projects');
		this.title.title = this.title.textContent;
		this.search.hidden = !!state.selectedId || (this.search.hidden && !state.query);
		this.search.value = state.query;
		this.sort.domNode.setAttribute('aria-pressed', String(state.descending));
		this.createButton.enabled = !state.busy;
		this.message.textContent = state.message ?? (state.loading ? localize('projects.loading', 'Loading projects…') : '');
		this.message.parentElement!.hidden = !state.message && !state.loading;
		this.retry.domNode.hidden = !state.message;
		this.retry.enabled = !state.loading && !state.busy;
		this.body.setAttribute('aria-busy', String(state.loading));
		if (state.selected) { this.renderProject(state.selected); }
		else if (state.selectedId && state.loading) { this.renderLoading(); }
		else if (!state.selectedId && this.library.getProjects().length) { this.renderCards(); }
		else if (!state.loading && !state.message) { this.renderEmpty(!!state.query); }
		if (focusKey) {
			(Array.from(this.body.querySelectorAll<HTMLElement>('[data-project-control]')).find(node => node.dataset.projectControl === focusKey) ?? this.title).focus();
		}
	}

	private button(parent: HTMLElement, options: IButtonOptions, key?: string): Button {
		const button = this.content.add(new Button(parent, { ...projectButtonStyles, ...options }));
		if (key) { button.domNode.dataset.projectControl = key; }
		return button;
	}

	private renderEmpty(searching: boolean): void {
		const document = this.domNode.ownerDocument;
		const empty = h(document, 'div', { className: 'ash-projects-empty' });
		const illustration = h(document, 'div', { className: 'ash-projects-illustration', attributes: { 'aria-hidden': 'true' } }, h(document, 'span'), h(document, 'span'), h(document, 'span'));
		empty.append(illustration,
			h(document, 'h2', {}, searching ? localize('projects.noResults', 'No matching projects') : localize('projects.emptyTitle', 'Looking to start a project?')),
			h(document, 'p', {}, searching ? localize('projects.searchHint', 'Try another name or clear your search.') : localize('projects.emptyDescription', 'Bring your materials and goals together in one space.')));
		this.button(empty, { label: searching ? localize('projects.clearSearch', 'Clear search') : localize('projects.new', 'New project'), presentation: 'secondary', onClick: () => searching ? this.library.setQuery('') : this.showProjectDialog() });
		this.body.append(empty);
	}

	private renderCards(): void {
		const document = this.domNode.ownerDocument;
		const list = h(document, 'ul', { className: 'ash-projects-grid', attributes: { 'aria-label': localize('projects.title', 'Projects') } });
		for (const project of this.library.getProjects()) {
			const row = h(document, 'li');
			const card = h(document, 'button', { className: 'ash-projects-card', properties: { type: 'button' }, attributes: { 'aria-label': project.name } });
			card.dataset.projectControl = project.id;
			card.append(h(document, 'span', { className: 'ash-projects-card-mark', attributes: { 'aria-hidden': 'true' } }), h(document, 'span', { className: 'ash-projects-card-name' }, project.name), h(document, 'span', { className: 'ash-projects-card-caption' }, localize('projects.open', 'Open project')));
			this.content.add(this.hover.setupDelayedHover(card, { content: project.name }));
			this.content.add(addDisposableListener(card, 'click', () => { void this.library.openProject(project.id).then(() => this.title.focus()); }));
			row.append(card); list.append(row);
		}
		this.body.append(list);
	}

	private renderProject(project: Project): void {
		const document = this.domNode.ownerDocument;
		const layout = h(document, 'div', { className: 'ash-projects-detail' });
		const overview = h(document, 'section', { className: 'ash-projects-overview' });
		const heading = h(document, 'div', { className: 'ash-projects-section-heading' }, h(document, 'h2', {}, localize('projects.goals', 'Project goals')));
		this.button(heading, { label: localize('projects.edit', 'Edit details'), icon: Lxicon.edit, onClick: () => this.showProjectDialog(project) }, 'edit');
		overview.append(heading, h(document, 'p', { className: 'ash-projects-description' }, project.description || localize('projects.noGoals', 'Add a description of what you want to achieve.')));
		const materials = h(document, 'section', { className: 'ash-projects-materials', attributes: { 'aria-label': localize('projects.materials', 'Materials') } });
		const materialsHeading = h(document, 'div', { className: 'ash-projects-section-heading' }, h(document, 'h2', {}, localize('projects.materials', 'Materials')));
		this.button(materialsHeading, { label: localize('projects.addFiles', 'Add files'), icon: Lxicon.add, enabled: !this.library.state.get().busy, onClick: () => { void this.addMaterials(project, 'file'); } }, 'add-files');
		materials.append(materialsHeading, h(document, 'p', { className: 'ash-projects-muted' }, localize('projects.materialsDescription', 'Keep images, PDFs, documents and other files close at hand.')));
		if (!project.materials.length) {
			materials.append(h(document, 'p', { className: 'ash-projects-materials-empty' }, localize('projects.noMaterials', 'Add your first material to this project.')));
		}
		const list = h(document, 'ul', { className: 'ash-projects-material-list' });
		for (const material of project.materials) {
			const row = h(document, 'li', { className: 'ash-projects-material' });
			const open = this.button(row, { label: material.name, icon: material.kind === 'folder' ? Lxicon.folders : Lxicon.file, onClick: () => { void this.openMaterial(material); } }, material.resource.toString());
			this.content.add(this.hover.setupDelayedHover(open.domNode, { content: material.resource.fsPath }));
			this.button(row, { label: localize('projects.removeMaterial', 'Remove {0} from project', material.name), icon: Lxicon.close, iconOnly: true, enabled: !this.library.state.get().busy, onClick: () => { void this.library.update(project, project.name, project.description, project.materials.filter(item => item.resource.toString() !== material.resource.toString())); } }, `remove:${material.resource}`);
			list.append(row);
		}
		materials.append(list);
		this.button(materials, { label: localize('projects.useFolder', 'Use a folder'), icon: Lxicon.folders, enabled: !this.library.state.get().busy, onClick: () => { void this.addMaterials(project, 'folder'); } }, 'add-folder');
		materials.append(h(document, 'p', { className: 'ash-projects-source-note' }, localize('projects.referenceHint', 'Files stay in their original location.')));
		layout.append(overview, materials);
		this.body.append(layout);
	}

	private renderLoading(): void {
		const document = this.domNode.ownerDocument;
		const skeleton = h(document, 'div', { className: 'ash-projects-skeleton', attributes: { 'aria-hidden': 'true' } }, h(document, 'div'), h(document, 'div'));
		this.body.append(skeleton);
	}

	private async addMaterials(project: Project, kind: ProjectMaterial['kind']): Promise<void> {
		try {
			const resources = await this.files.showOpenDialog({ title: localize('projects.addMaterials', 'Add project materials'), canSelectFiles: kind === 'file', canSelectFolders: kind === 'folder', canSelectMany: true });
			if (!resources || this.isDisposed) { return; }
			const materials = [...project.materials];
			for (const resource of resources) {
				if (!materials.some(item => item.resource.toString() === resource.toString())) { materials.push({ resource, name: basename(resource), kind }); }
			}
			await this.library.update(project, project.name, project.description, materials);
		} catch { this.showError(localize('projects.pickFailed', 'Could not add these materials. Try again.')); }
	}

	private async openMaterial(material: ProjectMaterial): Promise<void> {
		try {
			const resource = material.kind === 'folder' ? (await this.files.showOpenDialog({ defaultUri: material.resource, canSelectFiles: true, canSelectFolders: false }))?.[0] : material.resource;
			if (resource && !this.isDisposed) { await this.editors.openEditor({ resource }); }
		} catch { this.showError(localize('projects.openFailed', 'Could not open this material. Check that the source file is still available.')); }
	}

	private showError(message: string): void {
		if (this.isDisposed) { return; }
		this.message.textContent = message;
		this.message.parentElement!.hidden = false;
		this.retry.domNode.hidden = true;
	}

	private showProjectDialog(project?: Project): void {
		if (this.dialog.value) { return; }
		const store = new DisposableStore();
		this.dialog.value = store;
		const document = this.domNode.ownerDocument;
		const form = h(document, 'form', { className: 'ash-projects-form' });
		const nameLabel = h(document, 'label', {}, localize('projects.nameLabel', 'What are you working on?'));
		const name = h(document, 'input', { properties: { type: 'text', value: project?.name ?? '', required: true, maxLength: 200, placeholder: localize('projects.namePlaceholder', 'Name your project') } });
		nameLabel.append(name);
		const descriptionLabel = h(document, 'label', {}, localize('projects.descriptionLabel', 'What are you trying to achieve?'));
		const description = h(document, 'textarea', { properties: { value: project?.description ?? '', maxLength: 20000, placeholder: localize('projects.descriptionPlaceholder', 'Describe your project, goals, subject, etc…') } });
		descriptionLabel.append(description);
		const materials = [...(project?.materials ?? [])];
		let chosenFolder: ProjectMaterial | undefined;
		const folderRow = h(document, 'div', { className: 'ash-projects-folder-choice' });
		const feedback = h(document, 'p', { className: 'ash-projects-form-error', attributes: { role: 'alert' } });
		const folder = store.add(new Button(folderRow, {
			...projectButtonStyles, label: localize('projects.useFolder', 'Use a folder'), icon: Lxicon.folders, onClick: () => {
				void this.files.showOpenDialog({ canSelectFiles: false, canSelectFolders: true }).then(resources => {
					if (store.isDisposed || !resources?.[0]) { return; }
					const resource = resources[0];
					if (chosenFolder) { materials.splice(materials.indexOf(chosenFolder), 1); chosenFolder = undefined; }
					if (!materials.some(item => item.resource.toString() === resource.toString())) {
						chosenFolder = { resource, name: basename(resource), kind: 'folder' };
						materials.push(chosenFolder);
					}
					folder.label = basename(resource);
				}).catch(() => { if (!store.isDisposed) { feedback.textContent = localize('projects.pickFailed', 'Could not add these materials. Try again.'); } });
			}
		}));
		const actions = h(document, 'footer', { className: 'ash-projects-form-actions' });
		form.append(nameLabel, descriptionLabel, folderRow, feedback, actions);
		const dialog = store.add(new Dialog(this.domNode, { title: project ? localize('projects.edit', 'Edit details') : localize('projects.createTitle', 'Create a project'), content: form, dialogStyles: defaultDialogStyles }));
		dialog.element.classList.add('ash-projects-dialog');
		const close = store.add(new Button(dialog.element, { ...projectButtonStyles, label: localize('projects.close', 'Close'), icon: Lxicon.close, iconOnly: true, onClick: () => dialog.close() }));
		close.domNode.classList.add('ash-projects-dialog-close');
		store.add(new Button(actions, { ...projectButtonStyles, label: localize('projects.cancel', 'Cancel'), presentation: 'secondary', onClick: () => dialog.close() }));
		const submit = store.add(new Button(actions, { ...projectButtonStyles, label: project ? localize('projects.save', 'Save changes') : localize('projects.create', 'Create project'), presentation: 'primary', type: 'submit', enabled: !!name.value.trim() }));
		store.add(addDisposableListener(name, 'input', () => { submit.enabled = !!name.value.trim(); }));
		const id = generateUuid();
		store.add(addDisposableListener(form, 'submit', event => {
			event.preventDefault();
			if (!name.value.trim() || this.library.state.get().busy) { return; }
			submit.enabled = false; name.disabled = true; description.disabled = true; folder.enabled = false;
			const result = project ? this.library.update(project, name.value.trim(), description.value.trim(), materials) : this.library.create(id, name.value.trim(), description.value.trim(), materials);
			void result.then(saved => {
				if (store.isDisposed) { return; }
				if (saved) { dialog.close('saved'); }
				else { feedback.textContent = this.library.state.get().message ?? ''; submit.enabled = true; name.disabled = false; description.disabled = false; folder.enabled = true; }
			});
		}));
		void dialog.show().then(result => {
			if (this.dialog.value === store) { this.dialog.clear(); }
			if (result === 'saved' && !this.isDisposed) { this.title.focus(); }
		});
		name.focus();
	}

	private navigateCards(event: KeyboardEvent): void {
		if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { return; }
		const cards = Array.from(this.body.querySelectorAll<HTMLButtonElement>('.ash-projects-card'));
		const index = cards.indexOf(getActiveElement(this.domNode.ownerDocument) as HTMLButtonElement);
		if (index < 0) { return; }
		event.preventDefault();
		const columns = getComputedStyle(cards[index].parentElement!.parentElement!).gridTemplateColumns.split(' ').length;
		const next = event.key === 'Home' ? 0 : event.key === 'End' ? cards.length - 1 : index + (event.key === 'ArrowDown' ? columns : event.key === 'ArrowUp' ? -columns : event.key === 'ArrowLeft' ? -1 : 1);
		cards[Math.max(0, Math.min(cards.length - 1, next))].focus();
	}
}
