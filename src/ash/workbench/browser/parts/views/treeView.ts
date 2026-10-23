import './media/views.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { listRowHeight } from '../../../../base/common/uiSizes.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchAsyncDataTree } from '../../../../platform/list/browser/listService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { TreeItemCollapsibleState, type ITreeItem, type ITreeViewDataProvider } from '../../../common/views.js';
import { CheckboxStateHandler, TreeItemCheckbox } from './checkbox.js';
import { InlineEditInputBox } from './inlineEditInputBox.js';
import { ViewPane, type IViewPaneOptions } from './viewPane.js';

/** A retained presentation over provider-owned nodes, using the shared asynchronous tree. */
export class TreeView extends Disposable {
	public dataProvider: ITreeViewDataProvider | undefined;
	public visible = false;
	public container: HTMLElement | undefined;
	private tree: WorkbenchAsyncDataTree<null, ITreeItem> | undefined;
	private status: HTMLElement | undefined;
	private readonly rows = this._register(new DisposableMap<HTMLElement, DisposableStore>());
	private readonly editing = this._register(new MutableDisposable<InlineEditInputBox>());
	private readonly checkboxChanges = this._register(new CheckboxStateHandler());
	public readonly onDidChangeCheckboxState = this.checkboxChanges.onDidChangeCheckboxState;
	private readonly changedSelection = this._register(new Emitter<{ selection: readonly ITreeItem[]; focus: ITreeItem | undefined; }>());
	public readonly onDidChangeSelectionAndFocus = this.changedSelection.event;
	private readonly mounting = this._register(new MutableDisposable<DisposableStore>());
	private dirty = true;
	private initialized = false;
	private refreshing: Promise<void> | undefined;
	private readonly loadingChanged = this._register(new Emitter<boolean>());
	public readonly onDidChangeLoading = this.loadingChanged.event;

	constructor(
		public readonly id: string,
		public readonly title: string,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@ICommandService private readonly commands: ICommandService,
		@INotificationService private readonly notifications: INotificationService,
	) { super(); }

	public show(container: HTMLElement): void {
		if (this.container) {
			if (this.container !== container) { throw new Error('A TreeView has one DOM owner'); }
			return;
		}
		const mounting = this.mounting.value = new DisposableStore();
		const reads = new AbortController();
		mounting.add(toDisposable(() => reads.abort()));
		this.container = container;
		container.classList.add('ash-custom-tree-view');
		this.status = h(container.ownerDocument, 'div');
		this.status.className = 'ash-custom-tree-status';
		this.status.setAttribute('role', 'status');
		container.append(this.status);
		const viewport = h(container.ownerDocument, 'div');
		viewport.className = 'ash-custom-tree-viewport';
		container.append(viewport);
		const tree = this.tree = mounting.add(new WorkbenchAsyncDataTree<null, ITreeItem>(viewport, {
			hasChildren: node => node === null || node.collapsibleState !== TreeItemCollapsibleState.None,
			getChildren: async node => {
				const children = await this.dataProvider?.getChildren(node ?? undefined, reads.signal) ?? [];
				if (tree !== this.tree) { return []; }
				if (node === null) {
					this.status!.textContent = children.length ? '' : localize('treeView.empty', 'No items.');
				}
				return children;
			},
			getParent: node => node.parent ?? null,
		}, {
			configurationService: this.configuration,
			ariaLabel: this.title,
			scrolling: 'managed',
			getHeight: () => listRowHeight,
			identityProvider: { getId: node => node.handle },
			collapseByDefault: node => node.collapsibleState !== TreeItemCollapsibleState.Expanded,
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: node => node.label?.label ?? node.handle },
			onDidRemoveRow: row => {
				const content = row.querySelector<HTMLElement>('[data-tree-handle]');
				if (content) { this.rows.deleteAndDispose(content); }
			},
			renderElement: node => this.renderRow(node),
		}));
		const loading = new Set<ITreeItem | undefined>();
		mounting.add(tree.onDidChangeLoadState(event => {
			if (event.loading) loading.add(event.element);
			else loading.delete(event.element);
			this.loadingChanged.fire(loading.size > 0);
		}));
		mounting.add(tree.onDidOpen(event => {
			if (event.element.command) {
				void this.commands.executeCommand(event.element.command.id, ...event.element.command.arguments ?? []).catch(error => this.notifications.error(error));
			}
		}));
		mounting.add(tree.onDidChangeSelection(event => {
			this.changedSelection.fire({ selection: event.elements, focus: this.tree!.focus });
		}));
		mounting.add(addDisposableListener(tree.element, 'keydown', event => {
			const node = this.tree!.focus;
			if (event.key !== 'F2' || !node?.editable || !this.dataProvider?.getEditableData) { return; }
			event.preventDefault();
			event.stopPropagation();
			// Finish a read already in progress before attaching an editor to its row.
			void (this.refreshing ?? Promise.resolve()).then(() => {
				if (tree !== this.tree || !this.visible || tree.focus?.handle !== node.handle) { return; }
				const row = [...container.querySelectorAll<HTMLElement>('[data-tree-handle]')].find(row => row.dataset.treeHandle === node.handle);
				if (!row || !this.dataProvider?.getEditableData) { return; }
				const data = this.dataProvider.getEditableData(node);
				const editor = this.instantiation.createInstance(InlineEditInputBox, row, {
					...data,
					onFinish: async (value: string, success: boolean) => {
						try { await data.onFinish(value, success); }
						finally {
							if (this.editing.value === editor) { this.editing.clear(); }
							if (this.dirty) { await this.refresh(); }
						}
					},
				}, {
					ariaLabel: localize('treeView.rename', 'Rename {0}', node.label?.label ?? node.handle),
					value: node.label?.label ?? '',
				});
				this.editing.value = editor;
			}).catch(error => { if (!this.isDisposed) { this.notifications.error(error); } });
		}));
		const scopedContext = mounting.add(this.contextKeys.createScoped(container));
		scopedContext.createKey('customTreeViewFocused', true);
		const help = localize('treeView.help', 'Use Up and Down Arrow to select items, Right and Left Arrow to expand or collapse, Enter to run an item command, Tab and Space to change a checkbox, and F2 to rename editable items. In the rename field, Enter saves and Escape cancels. Open the accessible view with <keybinding:editor.action.accessibleView>.');
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			mounting.add(AccessibleViewRegistry.register({
				type, priority: 110, name: `tree-${this.id}`, when: ContextKeyExpr.has('customTreeViewFocused'),
				getProvider: () => {
					const focused = container.ownerDocument.activeElement;
					if (!this.visible || !(focused instanceof HTMLElement) || !container.contains(focused)) { return undefined; }
					return new AccessibleContentProvider(AccessibleViewProviderId.TreeView, { type },
						() => type === AccessibleViewType.Help ? help : this.getVisibleContent(),
						() => { if (focused.isConnected) { focused.focus(); } }, AccessibilityVerbositySettingId.TreeView);
				},
			}));
		}
		mounting.add(addDisposableListener(tree.element, 'focusin', () => {
			if (this.configuration.getValue<boolean>(AccessibilityVerbositySettingId.TreeView) !== false) { tree.element.setAttribute('aria-description', help); }
			else { tree.element.removeAttribute('aria-description'); }
		}));
		mounting.add(toDisposable(() => {
			this.loadingChanged.fire(false);
			this.editing.clear();
			this.rows.clearAndDisposeAll();
			this.tree = undefined;
			this.status = undefined;
			this.container = undefined;
			this.refreshing = undefined;
			this.initialized = false;
			this.dirty = true;
			this.visible = false;
			viewport.remove();
			container.replaceChildren();
			container.classList.remove('ash-custom-tree-view');
		}));

	}

	public hide(): void { this.mounting.clear(); }

	public setVisibility(visible: boolean): void {
		this.visible = visible;
		if (!visible) { this.editing.clear(); }
		if (visible && this.dirty) { void this.refresh(); }
	}

	public refresh(): Promise<void> {
		this.dirty = true;
		if (!this.tree || !this.visible || this.isDisposed) { return Promise.resolve(); }
		// Keep the edit's DOM and selection stable; its terminal callback flushes provider changes.
		if (this.editing.value && !this.editing.value.isDisposed) { return Promise.resolve(); }
		if (this.refreshing) { return this.refreshing; }
		const refresh = this.update(this.tree).finally(() => { if (this.refreshing === refresh) { this.refreshing = undefined; } });
		this.refreshing = refresh;
		return refresh;
	}

	private async update(tree: WorkbenchAsyncDataTree<null, ITreeItem>): Promise<void> {
		while (this.dirty && this.visible && tree === this.tree) {
			this.dirty = false;
			try {
				if (this.initialized) { await tree.updateChildren(null, { recursive: true }); }
				else { await tree.setInput(null); if (tree === this.tree) { this.initialized = true; } }
			} catch (error) {
				if (tree === this.tree) {
					this.status!.textContent = localize('treeView.failed', 'Could not load items: {0}', error instanceof Error ? error.message : String(error));
				}
			}
		}
	}

	public focus(): void { this.tree?.domFocus(); }
	public layout(height: number, width: number): void {
		if (!this.tree) { return; }
		this.tree.domNode.style.height = `${Math.max(0, height - (this.status?.offsetHeight ?? 0))}px`;
		this.tree.domNode.style.width = `${Math.max(0, width)}px`;
	}
	public getOptimalWidth(): number { return 240; }
	public getVisibleContent(): string {
		return (this.tree?.getVisibleElements() ?? []).map(node => {
			const text = `${node.label?.label ?? node.handle}${node.description ? ': ' + node.description : ''}`;
			if (!node.checkbox) { return text; }
			return `${text}, ${node.checkbox.isChecked ? localize('treeView.checked', 'Checked') : localize('treeView.unchecked', 'Unchecked')}`;
		}).join('\n');
	}

	private renderRow(node: ITreeItem): HTMLElement {
		const lifetime = new DisposableStore();
		const row = h(this.container!.ownerDocument, 'div');
		row.className = 'ash-custom-tree-row';
		row.dataset.treeHandle = node.handle;
		this.rows.set(row, lifetime);
		if (node.checkbox) {
			const checkbox = lifetime.add(new TreeItemCheckbox(row, this.checkboxChanges));
			checkbox.render(node);
		}
		const label = h(row.ownerDocument, 'span');
		label.className = 'ash-custom-tree-label';
		label.textContent = node.label?.label ?? node.handle;
		label.title = node.tooltip ?? label.textContent;
		row.append(label);
		if (node.description) {
			const description = h(row.ownerDocument, 'span');
			description.className = 'ash-custom-tree-description';
			description.textContent = node.description;
			description.title = node.description;
			row.append(description);
		}
		return row;
	}
}

/** The pane owns mounting and visibility; the extension binding owns the retained tree. */
export class TreeViewPane extends ViewPane {
	constructor(protected readonly treeView: TreeView, container: HTMLElement, options: IViewPaneOptions) {
		super(container, options);
		const loading = this._register(new MutableDisposable());
		this._register(treeView.onDidChangeLoading(active => {
			if (active && !loading.value) {
				const progress = this.getProgressIndicator().show(true, 150);
				loading.value = toDisposable(() => progress.done());
			} else if (!active) loading.clear();
		}));
		treeView.show(this.contentElement);
		this._register(toDisposable(() => treeView.hide()));
		this._register(this.onDidChangeBodyVisibility(visible => treeView.setVisibility(visible)));
	}
	public override focus(): void { this.treeView.focus(); }
	public override getOptimalWidth(): number { return this.treeView.getOptimalWidth(); }
	protected override layoutBody(height: number, width: number): void { this.treeView.layout(height, width); }
}
