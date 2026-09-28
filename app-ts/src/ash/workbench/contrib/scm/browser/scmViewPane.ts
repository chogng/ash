import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { ButtonActionViewItem, type ActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { IconLabel } from '../../../../base/browser/ui/iconlabel/iconlabel.js';
import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import type { IAction } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IResourceIconRenderer } from '../../../browser/labels.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { ISCMService, ISCMViewService, type ISCMProvider, type ISCMResource, type ISCMResourceGroup } from '../common/scm.js';

export const GIT_VIEW_ID = 'ash.gitView';

/** Displays resources and actions from the selected SCM provider. */
export class ScmViewPane extends ViewPane {
	private readonly repositorySelectorContainer: HTMLLabelElement;
	private readonly repositorySelector: HTMLSelectElement;
	private readonly commitInput: HTMLTextAreaElement;
	private readonly commitButton: Button;
	private readonly statusElement: HTMLDivElement;
	private readonly changesElement: HTMLDivElement;
	private readonly renderedChanges = this._register(new DisposableStore());
	private readonly providerListener = this._register(new MutableDisposable());
	private readonly actionViewItems: ScmActionViewItem[] = [];
	private renderedProvider: ISCMProvider | undefined;
	private renderedGroups: readonly ISCMResourceGroup[] | undefined;
	private commitTooltip = 'Commit staged changes';
	private busy = false;

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		@ISCMService private readonly scmService: ISCMService,
		@ISCMViewService private readonly scmViewService: ISCMViewService,
		@IResourceIconRenderer private readonly resourceIconRenderer: IResourceIconRenderer,
		@IContextMenuService private readonly contextMenuProvider: IContextMenuProvider,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
	) {
		super(container, options);
		this.contentElement.classList.add('ash-scm');
		const document = container.ownerDocument;
		this.repositorySelectorContainer = h(document, 'label');
		this.repositorySelectorContainer.className = 'ash-scm-repository-selector';
		const repositorySelectorLabel = h(document, 'span');
		repositorySelectorLabel.textContent = 'Repository';
		this.repositorySelector = h(document, 'select');
		this.repositorySelector.setAttribute('aria-label', 'Active source control repository');
		this.repositorySelectorContainer.append(repositorySelectorLabel, this.repositorySelector);
		const commitForm = h(document, 'form');
		commitForm.className = 'ash-scm-commit-form';
		this.commitInput = h(document, 'textarea');
		this.commitInput.className = 'ash-scm-commit-input';
		this.commitInput.name = 'commitMessage';
		this.commitInput.rows = 2;
		this.commitInput.setAttribute('aria-label', 'Commit message');
		const commitButton = this._register(new Button(commitForm, {
			label: 'Commit',
			icon: Lxicon.check,
			contentAlignment: 'labelCentered',
			type: 'submit',
			title: 'Commit staged changes',
		}));
		commitButton.toggleClassName('ash-scm-commit', true);
		this.commitButton = commitButton;
		commitForm.append(this.commitInput, commitButton.domNode);
		this.statusElement = h(document, 'div');
		this.statusElement.className = 'ash-scm-status ash-aria-live';
		this.statusElement.setAttribute('role', 'status');
		this.statusElement.setAttribute('aria-live', 'polite');
		this.changesElement = h(document, 'div');
		this.changesElement.className = 'ash-scm-changes';
		this.contentElement.append(this.repositorySelectorContainer, commitForm, this.statusElement, this.changesElement);
		this._register(addDisposableListener(this.repositorySelector, 'change', () => void this.selectRepository(this.repositorySelector.value)));
		this._register(addDisposableListener(commitForm, 'submit', event => { event.preventDefault(); void this.commit(); }));
		this._register(addDisposableListener(this.commitInput, 'input', () => {
			const provider = this.provider;
			if (provider) provider.input.value = this.commitInput.value;
		}));
		this._register(addDisposableListener(this.commitInput, 'keydown', event => {
			const keyboardEvent = event as KeyboardEvent;
			if (keyboardEvent.key === 'Enter' && (keyboardEvent.ctrlKey || keyboardEvent.metaKey)) {
				event.preventDefault();
				void this.commit();
			}
		}));
		this._register(scmService.onDidAddRepository(() => this.render()));
		this._register(scmService.onDidRemoveRepository(() => this.render()));
		this._register(scmViewService.onDidChangeActiveRepository(() => this.bindProvider()));
		this._register(resourceIconRenderer.onDidChangeResourceIcons(() => this.render(true)));
		this._register(workspaceContext.onDidChangeWorkspace(() => this.render()));
		this.bindProvider();
	}

	private get provider(): ISCMProvider | undefined { return this.scmViewService.activeRepository?.provider; }

	private bindProvider(): void {
		const provider = this.provider;
		this.providerListener.value = provider?.onDidChangeResources(() => this.render());
		this.render();
	}

	private async selectRepository(id: string): Promise<void> {
		const repository = this.scmService.getRepository(id);
		if (!repository || repository.id === this.scmViewService.activeRepository?.id) return;
		this.busy = true;
		this.render();
		try {
			await repository.provider.activate();
			if (!this.isDisposed) this.scmViewService.selectRepository(id);
		} catch (error) {
			if (!this.isDisposed) this.statusElement.textContent = error instanceof Error ? error.message : String(error);
		} finally {
			this.busy = false;
			if (!this.isDisposed) this.render();
		}
	}

	public async refresh(): Promise<void> {
		await this.provider?.refresh();
	}

	private async commit(): Promise<void> {
		const provider = this.provider;
		if (!provider || this.busy || provider.isBusy) return;
		provider.input.value = this.commitInput.value;
		await provider.input.accept();
		if (!this.isDisposed && this.provider === provider) {
			this.commitInput.value = provider.input.value;
			if (provider.statusMessage === 'Enter a commit message.') this.commitInput.focus();
			this.render();
		}
	}

	private render(forceResources = false): void {
		if (this.isDisposed) return;
		const repositories = [...this.scmService.repositories];
		const active = this.scmViewService.activeRepository;
		const provider = active?.provider;
		this.repositorySelector.replaceChildren(...repositories.map(repository => {
			const option = h(this.element.ownerDocument, 'option');
			option.value = repository.id;
			option.textContent = repository.provider.rootUri ? `${repository.provider.label} — ${repository.provider.rootUri.fsPath}` : repository.provider.label;
			option.selected = repository.id === active?.id;
			return option;
		}));
		this.repositorySelectorContainer.hidden = repositories.length <= 1;
		this.repositorySelector.disabled = this.busy || repositories.length <= 1;
		this.commitInput.placeholder = provider?.input.placeholder ?? '';
		if (provider && this.commitInput.value !== provider.input.value) this.commitInput.value = provider.input.value;
		this.commitInput.disabled = this.busy || !provider?.input.enabled;
		const buttonLabel = provider?.input.buttonLabel ?? 'Commit';
		if (this.commitButton.label !== buttonLabel) this.commitButton.label = buttonLabel;
		const buttonTooltip = provider?.input.buttonTooltip ?? 'Commit';
		if (this.commitTooltip !== buttonTooltip) {
			this.commitTooltip = buttonTooltip;
			this.commitButton.setTitle(buttonTooltip);
		}
		this.commitButton.enabled = !this.busy && provider?.isBusy !== true && provider?.input.enabled === true && provider.input.canAccept;
		this.statusElement.textContent = provider?.statusMessage ?? (this.workspaceContext.getWorkbenchState() === WorkbenchState.EMPTY
			? 'Open a folder to use source control.'
			: 'No source control repository found in the open folder.');
		const groups = provider?.groups;
		if (forceResources || provider !== this.renderedProvider || groups !== this.renderedGroups) {
			this.renderedProvider = provider;
			this.renderedGroups = groups;
			this.actionViewItems.length = 0;
			this.renderedChanges.clear();
			this.changesElement.replaceChildren();
			for (const group of groups ?? []) this.appendGroup(group);
		}
		for (const item of this.actionViewItems) item.setBusy(this.busy || provider?.isBusy === true);
	}

	private appendGroup(group: ISCMResourceGroup): void {
		const document = this.element.ownerDocument;
		const section = h(document, 'section');
		section.className = 'ash-scm-section';
		const heading = h(document, 'h3');
		heading.className = 'ash-scm-section-heading';
		heading.tabIndex = 0;
		const label = h(document, 'span');
		label.className = 'ash-scm-section-label';
		label.textContent = group.label;
		heading.append(label);
		this.renderActionToolbar(heading, group.actions, `${group.label} actions`).classList.add('ash-scm-section-actions');
		const count = h(document, 'span');
		count.className = 'ash-scm-section-count';
		count.textContent = String(group.resources.length);
		heading.append(count);
		const list = h(document, 'ul');
		list.className = 'ash-scm-list';
		for (const resource of group.resources) list.append(this.renderResource(resource));
		section.append(heading, list);
		this.changesElement.append(section);
	}

	private renderResource(resource: ISCMResource): HTMLLIElement {
		const document = this.element.ownerDocument;
		const item = h(document, 'li');
		item.className = 'ash-scm-change';
		const open = h(document, 'button');
		open.type = 'button';
		open.className = 'ash-scm-change-open';
		const name = basename(resource.path);
		const parentPath = dirname(resource.path);
		const fileLabel = this.renderedChanges.add(new IconLabel(open, {
			label: name,
			description: parentPath || undefined,
			reserveIconSpace: true,
			renderIcon: container => this.resourceIconRenderer.renderFileIcon(resource.sourceUri, container),
			title: resource.originalPath ? `${resource.originalPath} → ${resource.path}` : resource.path,
		}));
		fileLabel.element.classList.add('ash-scm-change-label');
		fileLabel.element.querySelector('.ash-icon-label-description')?.classList.add('ash-scm-change-description');
		open.setAttribute('aria-label', resource.openLabel);
		open.append(fileLabel.element);
		this.renderedChanges.add(addDisposableListener(open, 'click', event => {
			if ((event as MouseEvent).detail > 1) return;
			void resource.open({ pinned: false });
		}));
		this.renderedChanges.add(addDisposableListener(open, 'dblclick', () => void resource.open({ pinned: true })));
		item.append(open);
		this.renderActionToolbar(item, resource.actions, `Actions for ${resource.path}`).classList.add('ash-scm-change-actions');
		const badge = h(document, 'span');
		badge.className = `ash-scm-change-status status-${resource.decorations.kind}`;
		badge.textContent = resource.decorations.badge;
		badge.title = resource.decorations.tooltip;
		item.append(badge);
		return item;
	}

	private renderActionToolbar(container: HTMLElement, actions: readonly IAction[], ariaLabel: string): HTMLDivElement {
		const toolbar = this.renderedChanges.add(new WorkbenchToolBar(container, this.contextMenuProvider, {
			ariaLabel,
			actionViewItemProvider: (action, options) => {
				const item = new ScmActionViewItem(action, () => this.busy || this.provider?.isBusy === true, options);
				this.actionViewItems.push(item);
				return item;
			},
		}));
		toolbar.setActions(actions);
		toolbar.element.classList.add('ash-scm-action-toolbar');
		return toolbar.element;
	}
}

class ScmActionViewItem extends ButtonActionViewItem {
	constructor(action: IAction, private readonly isBusy: () => boolean, options: ActionViewItemOptions) { super(action, options); }
	public override render(container: HTMLElement): void { super.render(container); this.setBusy(this.isBusy()); }
	public setBusy(busy: boolean): void { this.button.enabled = this.action.enabled && !busy; }
}

function basename(path: string): string { return path.replaceAll('\\', '/').split('/').at(-1) ?? path; }
function dirname(path: string): string {
	const normalized = path.replaceAll('\\', '/');
	const separator = normalized.lastIndexOf('/');
	return separator < 0 ? '' : normalized.slice(0, separator);
}
