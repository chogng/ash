import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { ButtonActionViewItem, type ActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { CountBadge } from '../../../../base/browser/ui/countBadge/countBadge.js';
import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import type { IAction } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { registerOpenEditorListeners } from '../../../../platform/editor/browser/editor.js';
import { WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IResourceIconRenderer, IResourceLabelService, type ResourceLabels } from '../../../browser/labels.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { SCMInputWidget } from './scmInput.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { ISCMService, ISCMViewService, type ISCMProvider, type ISCMResource, type ISCMResourceGroup } from '../common/scm.js';

export const GIT_VIEW_ID = 'ash.gitView';

type TreeElement =
	| { readonly id: string; readonly group: ISCMResourceGroup; }
	| { readonly id: string; readonly resource: ISCMResource; };

/** Displays resources and actions from the selected SCM provider. */
export class ScmViewPane extends ViewPane {
	private readonly commitInput: SCMInputWidget;
	private readonly commitForm: HTMLFormElement;
	private readonly commitButton: Button;
	private readonly statusElement: HTMLDivElement;
	private readonly tree: WorkbenchObjectTree<TreeElement>;
	private readonly resourceLabels: ResourceLabels;
	private readonly renderedRows = this._register(new DisposableMap<HTMLElement, DisposableStore>());
	private readonly providerListener = this._register(new MutableDisposable());
	private readonly actionViewItems = new Set<ScmActionViewItem>();
	private renderedProvider: ISCMProvider | undefined;
	private renderedGroups: readonly ISCMResourceGroup[] | undefined;
	private commitTooltip = 'Commit staged changes';

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		@ISCMService scmService: ISCMService,
		@ISCMViewService private readonly scmViewService: ISCMViewService,
		@IResourceLabelService resourceLabelService: IResourceLabelService,
		@IContextMenuService private readonly contextMenuProvider: IContextMenuProvider,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
		@IConfigurationService configurationService: IConfigurationService,
		@IResourceIconRenderer resourceIconRenderer: IResourceIconRenderer,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(container, options);
		this.resourceLabels = this._register(resourceLabelService.createGroup());
		this.contentElement.classList.add('ash-scm');
		const document = container.ownerDocument;
		const commitForm = h(document, 'form');
		this.commitForm = commitForm;
		commitForm.className = 'ash-scm-commit-form';
		this.commitInput = this._register(instantiationService.createInstance(SCMInputWidget, commitForm));
		const commitButton = this._register(new Button(commitForm, {
			label: 'Commit',
			icon: Lxicon.check,
			contentAlignment: 'labelCentered',
			type: 'submit',
			title: 'Commit staged changes',
		}));
		commitButton.toggleClassName('ash-scm-commit', true);
		this.commitButton = commitButton;
		this.statusElement = h(document, 'div');
		this.statusElement.className = 'ash-scm-status ash-aria-live';
		this.statusElement.setAttribute('role', 'status');
		this.statusElement.setAttribute('aria-live', 'polite');
		const changesContainer = h(document, 'div');
		changesContainer.className = 'ash-scm-changes';
		this.contentElement.append(commitForm, this.statusElement, changesContainer);
		this.tree = this._register(new WorkbenchObjectTree<TreeElement>(changesContainer, {
			configurationService,
			ariaLabel: localize('scm.changesTree', 'Source control changes'),
			scrolling: 'managed',
			modelOptions: { identityProvider: { getId: element => element.id } },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: element => 'group' in element ? element.group.label : element.resource.path },
			expandOnlyOnTwistieClick: false,
			expandOnDoubleClick: false,
			reuseRows: true,
			onDidRemoveRow: row => {
				const content = row.querySelector<HTMLElement>('.ash-scm-section-heading, .ash-scm-change');
				if (content) { this.renderedRows.deleteAndDispose(content); }
			},
			renderElement: element => 'group' in element ? this.renderGroup(element.group) : this.renderResource(element),
		}));
		const updateTwistieLayout = () => {
			const theme = resourceIconRenderer.getFileIconTheme();
			// In a flat changes list, file icons occupy the empty arrow column even when the theme supplies folder icons.
			this.tree.updateOptions({
				twistieAdditionalCssClass: element => 'resource' in element && theme.hasFileIcons
					? 'ash-tree-twistie-hidden'
					: 'ash-tree-twistie-with-icon-gap'
			});
		};
		updateTwistieLayout();
		this._register(resourceIconRenderer.onDidChangeResourceIcons(updateTwistieLayout));
		this.tree.element.setAttribute('aria-description', localize('scm.changesTreeHelp', 'Use Up and Down to preview files, Left to collapse, and Right to expand a group. Press Enter to open and pin a file, or Space to preview while keeping focus here. Hold Ctrl, Command, or Alt when clicking or pressing Enter to open in a side group. Double-click pins the file and focuses its editor. Press F1 for Git branch, worktree, stash, tag and remote commands, integration continue or abort, and partial staging.'));
		this._register(this.tree.onDidOpen(event => {
			if ('resource' in event.element) {
				void event.element.resource.open(event.editorOptions, event.sideBySide);
			} else if (event.browserEvent.type === 'keydown') {
				this.tree.toggleCollapsed(event.element.id);
			}
		}));
		this._register(addDisposableListener(commitForm, 'submit', event => { event.preventDefault(); void this.commit(); }));
		// Capture acceptance before the editor handles Enter; plain Enter remains a message line break.
		this._register(addDisposableListener(commitForm, 'keydown', event => {
			const keyboardEvent = event as KeyboardEvent;
			if (!keyboardEvent.isComposing && !keyboardEvent.altKey && !keyboardEvent.shiftKey && keyboardEvent.key === 'Enter' && (keyboardEvent.ctrlKey || keyboardEvent.metaKey)) {
				event.preventDefault();
				event.stopPropagation();
				void this.commit();
			}
		}, { capture: true }));
		this._register(scmService.onDidAddRepository(() => this.render()));
		this._register(scmService.onDidRemoveRepository(() => this.render()));
		this._register(scmViewService.onDidChangeActiveRepository(() => this.bindProvider()));
		this._register(workspaceContext.onDidChangeWorkspace(() => this.render()));
		this.bindProvider();
	}

	private get provider(): ISCMProvider | undefined { return this.scmViewService.activeRepository?.provider; }

	private bindProvider(): void {
		const provider = this.provider;
		this.providerListener.value = provider?.onDidChangeResources(() => this.render());
		this.render();
	}

	public async refresh(): Promise<void> {
		await this.provider?.refresh();
	}

	private async commit(): Promise<void> {
		const provider = this.provider;
		if (!provider || provider.isBusy) return;
		await provider.input.accept();
		if (!this.isDisposed && this.provider === provider) {
			if (provider.statusMessage === 'Enter a commit message.') this.commitInput.focus();
			this.render();
		}
	}

	private render(): void {
		if (this.isDisposed) return;
		const active = this.scmViewService.activeRepository;
		const provider = active?.provider;
		this.commitForm.hidden = !provider;
		this.commitForm.classList.toggle('hidden', !provider);
		this.commitInput.input = provider?.input;
		const buttonLabel = provider?.input.buttonLabel ?? 'Commit';
		if (this.commitButton.label !== buttonLabel) this.commitButton.label = buttonLabel;
		const buttonTooltip = provider?.input.buttonTooltip ?? 'Commit';
		if (this.commitTooltip !== buttonTooltip) {
			this.commitTooltip = buttonTooltip;
			this.commitButton.setTitle(buttonTooltip);
		}
		this.commitButton.enabled = provider?.isBusy !== true && provider?.input.enabled === true && provider.input.canAccept;
		this.statusElement.classList.toggle('ash-aria-live', !!provider);
		this.statusElement.classList.toggle('ash-scm-empty', !provider);
		this.statusElement.textContent = provider?.statusMessage ?? (this.workspaceContext.getWorkbenchState() === WorkbenchState.EMPTY
			? localize('scm.emptyWindow', 'Open a folder to use source control.')
			: localize('scm.noRepository', 'No source control repository found in the open folder.'));
		const groups = provider?.groups;
		if (provider !== this.renderedProvider || groups !== this.renderedGroups) {
			this.renderedProvider = provider;
			this.renderedGroups = groups;
			// Provider snapshots replace group objects; repository/group identities keep tree state stable.
			this.tree.setChildren((groups ?? []).map(group => ({
				element: { id: JSON.stringify([active!.id, group.id]), group },
				children: group.resources.map(resource => ({
					element: { id: JSON.stringify([active!.id, group.id, resource.path]), resource },
				})),
			})));
		}
		for (const item of this.actionViewItems) item.setBusy(provider?.isBusy === true);
	}

	private renderGroup(group: ISCMResourceGroup): HTMLElement {
		const document = this.element.ownerDocument;
		const heading = h(document, 'div');
		heading.className = 'ash-scm-section-heading';
		const resources = this.renderedRows.set(heading, new DisposableStore());
		const label = h(document, 'span');
		label.className = 'ash-scm-section-label';
		label.textContent = group.label;
		label.title = group.label;
		heading.append(label);
		this.renderActionToolbar(heading, group.actions, `${group.label} actions`, resources).classList.add('ash-scm-section-actions');
		const count = resources.add(new CountBadge(heading, { titleFormat: localize('scm.resourceCount', '{0} changes') }));
		count.domNode.classList.add('ash-scm-section-count');
		count.setCount(group.resources.length);
		return heading;
	}

	private renderResource(element: { readonly id: string; readonly resource: ISCMResource; }): HTMLElement {
		const resource = element.resource;
		const document = this.element.ownerDocument;
		const item = h(document, 'div');
		item.className = 'ash-scm-change';
		const resources = this.renderedRows.set(item, new DisposableStore());
		const open = h(document, 'button');
		open.type = 'button';
		open.className = 'ash-scm-change-open';
		const name = basename(resource.path);
		const parentPath = dirname(resource.path);
		const fileLabel = resources.add(this.resourceLabels.create(open));
		fileLabel.setResource({ resource: resource.sourceUri, name, description: parentPath || undefined }, {
			reserveIconSpace: true,
			strikethrough: resource.decorations.kind === 'deleted',
			title: resource.originalPath ? `${resource.originalPath} → ${resource.path}` : resource.path,
			extraClasses: ['ash-scm-change-label'],
		});
		open.setAttribute('aria-label', resource.openLabel);
		open.append(fileLabel.element);
		resources.add(addDisposableListener(open, 'mousedown', event => event.stopPropagation()));
		resources.add(addDisposableListener(open, 'keydown', event => event.stopPropagation()));
		resources.add(addDisposableListener(open, 'keydown', event => {
			if (event.key === 'Enter' && (event.ctrlKey || event.metaKey || event.altKey)) {
				event.preventDefault();
				void resource.open({ pinned: true, preserveFocus: false }, true);
			}
		}));
		resources.add(registerOpenEditorListeners(open, options => {
			this.tree.setFocus(element.id);
			this.tree.setSelection([element.id]);
			// Git snapshots replace row buttons; previews keep focus on the retained tree instead.
			if (options.editorOptions.preserveFocus) {
				this.tree.domFocus();
			}
			void resource.open(options.editorOptions, options.openToSide);
		}));
		item.append(open);
		this.renderActionToolbar(item, resource.actions, `Actions for ${resource.path}`, resources).classList.add('ash-scm-change-actions');
		const badge = h(document, 'span');
		badge.className = `ash-scm-change-status status-${resource.decorations.kind}`;
		badge.textContent = resource.decorations.badge;
		badge.title = resource.decorations.tooltip;
		item.append(badge);
		return item;
	}

	private renderActionToolbar(container: HTMLElement, actions: readonly IAction[], ariaLabel: string, resources: DisposableStore): HTMLDivElement {
		const toolbar = resources.add(new WorkbenchToolBar(container, this.contextMenuProvider, {
			ariaLabel,
			presentation: 'inherit-foreground',
			actionViewItemProvider: (action, options) => {
				const item = new ScmActionViewItem(action, () => this.provider?.isBusy === true, options);
				this.actionViewItems.add(item);
				resources.add(toDisposable(() => this.actionViewItems.delete(item)));
				return item;
			},
		}));
		toolbar.setActions(actions);
		toolbar.element.classList.add('ash-scm-action-toolbar');
		// Toolbar input belongs to its buttons, rather than the containing tree row.
		for (const type of ['mousedown', 'click', 'dblclick', 'keydown']) {
			resources.add(addDisposableListener(toolbar.element, type, event => event.stopPropagation()));
		}
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
