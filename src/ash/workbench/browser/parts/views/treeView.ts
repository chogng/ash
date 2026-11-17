import './media/views.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IContextKeyService, type IScopedContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchAsyncDataTree } from '../../../../platform/list/browser/listService.js';
import type { IAsyncDataTreeViewState } from '../../../../base/browser/ui/tree/asyncDataTree.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { TreeItemCollapsibleState, ViewsRegistry, type ITreeItem, type ITreeViewDataProvider, type ITreeViewOptions, type ITreeViewDragAndDropController } from '../../../common/views.js';
import { CancellationTokenSource, cancelOnDispose } from '../../../../base/common/cancellation.js';
import { VSDataTransfer, createStringDataTransferItem, matchesMimeType } from '../../../../base/common/dataTransfer.js';
import { createUuid } from '../../../../base/common/uuid.js';
import { ITreeViewsDnDService } from '../../../../editor/common/services/treeViewsDndService.js';
import { Action, type IAction } from '../../../../base/common/actions.js';
import { CheckboxStateHandler, TreeItemCheckbox } from './checkbox.js';
import { InlineEditInputBox } from './inlineEditInputBox.js';
import { ViewPane, ViewWelcomeController, type IViewPaneOptions } from './viewPane.js';
import { IconLabel } from '../../../../base/browser/ui/iconlabel/iconlabel.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { IMenuService, MenuId, type IMenu } from '../../../../platform/actions/common/actions.js';
import { getActionBarActions } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { isDarkColorScheme } from '../../../../platform/theme/common/theme.js';
import { IResourceIconRenderer } from '../../labels.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createObjectUrl } from '../../../../base/browser/fileAccess.js';
import { getMediaMime } from '../../../../base/common/mime.js';

/** A retained presentation over provider-owned nodes, using the shared asynchronous tree. */
export class TreeView extends Disposable {
	public dataProvider: ITreeViewDataProvider | undefined;
	public dragAndDropController: ITreeViewDragAndDropController | undefined;
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
	private readonly pendingRefresh = new Set<ITreeItem>();
	private viewState: IAsyncDataTreeViewState | undefined;
	private initialized = false;
	private refreshing: Promise<void> | undefined;
	private readonly loadingChanged = this._register(new Emitter<boolean>());
	public readonly onDidChangeLoading = this.loadingChanged.event;
	private readonly optionsChanged = this._register(new Emitter<void>());
	public readonly onDidChangeActions = this.optionsChanged.event;
	private readonly visibilityChanged = this._register(new Emitter<boolean>());
	public readonly onDidChangeVisibility = this.visibilityChanged.event;
	private readonly expanded = this._register(new Emitter<ITreeItem>());
	public readonly onDidExpandItem = this.expanded.event;
	private readonly collapsed = this._register(new Emitter<ITreeItem>());
	public readonly onDidCollapseItem = this.collapsed.event;
	private options: ITreeViewOptions = {};
	private empty = false;
	private readonly emptyChanged = this._register(new Emitter<void>());
	public readonly onDidChangeWelcomeState = this.emptyChanged.event;
	private readonly collapseAction: Action;
	private dimensions: { height: number; width: number; } | undefined;
	private presentationDirty = false;

	constructor(
		public readonly id: string,
		private readonly initialTitle: string,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@ICommandService private readonly commands: ICommandService,
		@INotificationService private readonly notifications: INotificationService,
		@IMenuService private readonly menus: IMenuService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@IMarkdownRendererService private readonly markdown: IMarkdownRendererService,
		@IThemeService private readonly themes: IThemeService,
		@IResourceIconRenderer private readonly resourceIcons: IResourceIconRenderer,
		@ITreeViewsDnDService private readonly dragTransfers: ITreeViewsDnDService,
		@IFileService private readonly files: IFileService,
	) {
		super();
		this.collapseAction = this._register(new Action(`treeView.${id}.collapseAll`, localize('treeView.collapseAll', 'Collapse All'), '', true, () => this.collapseAll()));
		this.collapseAction.icon = { id: 'collapse-all' };
		this._register(themes.onDidColorThemeChange(() => this.rerender()));
		this._register(resourceIcons.onDidChangeResourceIcons(() => this.rerender()));
	}

	public get title(): string { return this.options.title ?? this.initialTitle; }
	public get description(): string | undefined { return this.options.description; }
	public get badge(): ITreeViewOptions['badge'] { return this.options.badge; }
	public get isEmpty(): boolean { return this.empty && !this.options.message; }
	public getActions(): readonly IAction[] { return this.options.showCollapseAllAction ? [this.collapseAction] : []; }
	public configure(options: ITreeViewOptions): void {
		const remount = options.canSelectMany !== undefined && options.canSelectMany !== this.options.canSelectMany;
		this.options = { ...this.options, ...options };
		if (remount && this.container) {
			const container = this.container;
			const visible = this.visible;
			this.hide();
			this.show(container);
			this.setVisibility(visible);
		}
		if (this.status) { this.status.textContent = this.options.message ?? ''; }
		if (!remount) {
			this.rerender();
		}
		if (this.dimensions) { this.layout(this.dimensions.height, this.dimensions.width); }
		this.tree?.element.setAttribute('aria-label', this.title);
		this.optionsChanged.fire();
		this.emptyChanged.fire();
	}

	private rerender(): void {
		if (this.editing.value && !this.editing.value.isDisposed) { this.presentationDirty = true; return; }
		this.presentationDirty = false;
		this.tree?.rerender();
	}

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
		const dragging = mounting.add(new MutableDisposable<DisposableStore>());
		const menuContext = new MutableDisposable<IScopedContextKeyService>();
		mounting.add(toDisposable(() => {
			if (menuContext.value) { this.contextMenus.hideContextMenu(); }
			menuContext.dispose();
		}));
		const token = cancelOnDispose(mounting);
		const dragMime = 'application/vnd.ash.tree-drag';
		const acceptedDrop = (types: readonly string[]) => this.dragAndDropController?.dropMimeTypes.some(mime => matchesMimeType(mime, types)) === true;
		const tree = this.tree = mounting.add(new WorkbenchAsyncDataTree<null, ITreeItem>(viewport, {
			hasChildren: node => node === null || node.collapsibleState !== TreeItemCollapsibleState.None,
			getChildren: async node => {
				const children = await this.dataProvider?.getChildren(node ?? undefined, reads.signal) ?? [];
				if (tree !== this.tree) { return []; }
				if (node === null) {
					this.status!.textContent = this.options.message ?? (children.length ? '' : localize('treeView.empty', 'No items.'));
					this.empty = children.length === 0;
					this.emptyChanged.fire();
				}
				return children;
			},
			getParent: node => node.parent ?? null,
		}, {
			configurationService: this.configuration,
			ariaLabel: this.title,
			multipleSelectionSupport: this.options.canSelectMany === true,
			dnd: {
				getDragURI: node => this.dragAndDropController?.dragMimeTypes.length ? node.resourceUri?.toString() ?? node.handle : undefined,
				getDragLabel: nodes => nodes.map(node => node.label?.label ?? node.handle).join(', '),
				onDragStart: (data, event) => {
					const controller = this.dragAndDropController;
					if (!controller || !event.dataTransfer) { return; }
					const lifetime = dragging.value = new DisposableStore();
					const cancellation = new CancellationTokenSource(token);
					const uuid = createUuid();
					const handles = data.elements.map(node => node.handle);
					event.dataTransfer.setData(dragMime, JSON.stringify({ uuid, treeId: this.id, handles }));
					for (const mime of controller.dragMimeTypes) { event.dataTransfer.setData(mime, ''); }
					const transfer = controller.handleDrag(handles, uuid, cancellation.token);
					this.dragTransfers.addDragOperationTransfer(uuid, transfer);
					// Attach the rejection handler immediately: a drag can end without a drop.
					void transfer.catch(error => { if (!cancellation.token.isCancellationRequested) { this.notifications.error(String(error)); } });
					lifetime.add(toDisposable(() => {
						if (this.dragTransfers.removeDragOperationTransfer(uuid)) {
							cancellation.dispose(true);
							controller.handleDragEnd?.(uuid);
						} else {
							// A drop owns the in-flight payload after consuming it from the registry.
							void transfer.finally(() => { cancellation.dispose(); controller.handleDragEnd?.(uuid); }).catch(() => undefined);
						}
					}));
				},
				onDragOver: (data) => ({ accept: acceptedDrop(data.types), autoExpand: true }),
				drop: (_data, target, _index, _sector, event) => {
					const controller = this.dragAndDropController;
					if (!controller || !event.dataTransfer || !acceptedDrop([...event.dataTransfer.types])) { return; }
					const transfer = new VSDataTransfer();
					for (const mime of event.dataTransfer.types) {
						if (mime !== dragMime && acceptedDrop([mime])) { transfer.replace(mime, createStringDataTransferItem(event.dataTransfer.getData(mime))); }
					}
					let source: { uuid: string; treeId: string; handles: string[]; } | undefined;
					try {
						const raw: unknown = JSON.parse(event.dataTransfer.getData(dragMime) || 'null');
						if (raw && typeof raw === 'object' && 'uuid' in raw && typeof raw.uuid === 'string' && 'treeId' in raw && typeof raw.treeId === 'string'
							&& 'handles' in raw && Array.isArray(raw.handles) && raw.handles.length <= 10000 && raw.handles.every(handle => typeof handle === 'string' && handle.length <= 1024)) { source = raw as typeof source; }
					} catch { /* External drags need no Ash metadata. */ }
					const pending = this.dragTransfers.removeDragOperationTransfer(source?.uuid);
					void (async () => {
						const internal = await pending;
						if (token.isCancellationRequested) { return; }
						for (const [mime, item] of internal ?? []) { if (acceptedDrop([mime])) { transfer.replace(mime, item); } }
						await controller.handleDrop(transfer, target, token, source?.uuid, source?.treeId, source?.handles);
					})().catch(error => { if (!token.isCancellationRequested) { this.notifications.error(String(error)); } });
				},
				onDragEnd: () => dragging.clear(),
			},
			accessibilityProvider: { getAriaLabel: node => node.accessibilityInformation?.label ?? `${node.label?.label ?? node.handle}${node.description ? ': ' + node.description : ''}` },
			scrolling: 'managed',
			getHeight: () => 22,
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
		const selectionChanged = () => this.changedSelection.fire({ selection: tree.selection, focus: tree.focus });
		mounting.add(tree.onDidChangeSelection(selectionChanged));
		mounting.add(tree.onDidChangeFocus(selectionChanged));
		mounting.add(tree.onDidChangeCollapseState(event => {
			(event.collapsed ? this.collapsed : this.expanded).fire(event.element);
		}));
		mounting.add(tree.onContextMenu(event => {
			const node = event.element;
			if (!node) { return; }
			event.browserEvent.preventDefault();
			const scope = menuContext.value = this.contextKeys.getContextKeyService(container).createScoped(h(container.ownerDocument, 'div'));
			scope.createKey('view', this.id);
			scope.createKey('viewItem', node.contextValue ?? '');
			this.contextMenus.showContextMenu({
				menuId: MenuId.for('view/item/context'), contextKeyService: scope,
				menuActionOptions: { arg: { viewId: this.id, handle: node.handle } },
				getAnchor: () => event.anchor,
				onHide: () => { if (menuContext.value === scope) { menuContext.clear(); } if (this.tree === tree && !tree.isDisposed) { tree.domFocus(); } },
			});
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
							await this.flushRefresh();
							if (this.presentationDirty) { this.rerender(); }
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
		const help = [
			localize('treeView.help', 'Use Up and Down Arrow to select items, Right and Left Arrow to expand or collapse, Enter to run an item command, Tab and Space to change a checkbox, F2 to rename editable items, and Shift+F10 to open item actions. In the rename field, Enter saves and Escape cancels. Open the accessible view with <keybinding:editor.action.accessibleView>.'),
			this.options.canSelectMany ? localize('treeView.multiSelectHelp', 'Use Shift+Arrow to extend the selection, or Ctrl or Command+click to toggle individual items.') : '',
		].filter(Boolean).join('\n');
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
			this.presentationDirty = false;
			this.visible = false;
			viewport.remove();
			// The pane may host welcome content alongside the tree's owned nodes.
			container.querySelector(':scope > .ash-custom-tree-status')?.remove();
			container.classList.remove('ash-custom-tree-view');
		}));

	}

	public hide(): void {
		if (this.initialized) { this.viewState = this.tree?.getViewState(); }
		this.setVisibility(false);
		this.mounting.clear();
	}

	public setVisibility(visible: boolean): void {
		const changed = this.visible !== visible;
		this.visible = visible;
		if (changed) { this.visibilityChanged.fire(visible); }
		if (!visible) { this.editing.clear(); }
		if (visible) { void this.flushRefresh(); }
	}

	public refresh(items?: readonly ITreeItem[]): Promise<void> {
		if (!items) { this.dirty = true; this.pendingRefresh.clear(); }
		else if (!this.dirty) { for (const item of items) { this.pendingRefresh.add(item); } }
		return this.flushRefresh();
	}

	private flushRefresh(): Promise<void> {
		if (!this.tree || !this.visible || this.isDisposed) { return Promise.resolve(); }
		// Keep the edit's DOM and selection stable; its terminal callback flushes provider changes.
		if (this.editing.value && !this.editing.value.isDisposed) { return Promise.resolve(); }
		if (this.refreshing) { return this.refreshing; }
		const refresh = this.update(this.tree).finally(() => { if (this.refreshing === refresh) { this.refreshing = undefined; } });
		this.refreshing = refresh;
		return refresh;
	}

	private async update(tree: WorkbenchAsyncDataTree<null, ITreeItem>): Promise<void> {
		while ((this.dirty || this.pendingRefresh.size) && this.visible && tree === this.tree) {
			const items = this.dirty ? undefined : [...this.pendingRefresh];
			this.dirty = false;
			this.pendingRefresh.clear();
			try {
				this.status!.textContent = this.options.message ?? '';
				if (this.initialized) {
					for (const item of items ?? [null]) {
						await tree.updateChildren(item, { recursive: true, deferIfCollapsed: item !== null });
						if (tree !== this.tree) { return; }
					}
					// Providers may update their retained node objects without changing identity.
					this.rerender();
				}
				else {
					await tree.setInput(null, this.viewState);
					if (tree === this.tree) { this.initialized = true; this.viewState = undefined; }
				}
			} catch (error) {
				if (tree === this.tree) {
					this.status!.textContent = localize('treeView.failed', 'Could not load items: {0}', error instanceof Error ? error.message : String(error));
				}
			} finally {
				if (tree === this.tree && this.dimensions) { this.layout(this.dimensions.height, this.dimensions.width); }
			}
		}
	}

	public focus(): void { this.tree?.domFocus(); }
	public async reveal(item: ITreeItem): Promise<void> {
		await this.flushRefresh();
		const tree = this.tree;
		if (!tree) { return; }
		const parents: ITreeItem[] = [];
		for (let parent = item.parent; parent; parent = parent.parent) { parents.unshift(parent); }
		for (const parent of parents) { await tree.expand(parent); if (tree !== this.tree) { return; } }
		tree.reveal(item);
	}
	public async expand(items: readonly ITreeItem[]): Promise<void> {
		await this.flushRefresh();
		const tree = this.tree;
		if (!tree) { return; }
		for (const item of items) { await tree.expand(item); if (tree !== this.tree) { return; } }
	}
	public collapseAll(): void { this.tree?.collapseAll(); }
	public setSelection(items: readonly ITreeItem[]): void { this.tree?.setSelection(items); }
	public getSelection(): readonly ITreeItem[] { return this.tree?.selection ?? []; }
	public getFocus(): ITreeItem | undefined { return this.tree?.focus; }
	public setFocus(item: ITreeItem): void { this.tree?.setFocus(item); }
	public layout(height: number, width: number): void {
		this.dimensions = { height, width };
		if (!this.tree) { return; }
		this.tree.layout(Math.max(0, height - (this.status?.offsetHeight ?? 0)), Math.max(0, width));
	}
	public getOptimalWidth(): number {
		return Math.max(0, ...[...this.container?.querySelectorAll<HTMLElement>('.ash-custom-tree-row') ?? []].map(row => row.scrollWidth));
	}
	public getVisibleContent(): string {
		const items = (this.tree?.getVisibleElements() ?? []).map(node => {
			const text = `${node.label?.label ?? node.handle}${node.description ? ': ' + node.description : ''}`;
			if (!node.checkbox) { return text; }
			return `${text}, ${node.checkbox.isChecked ? localize('treeView.checked', 'Checked') : localize('treeView.unchecked', 'Unchecked')}`;
		});
		return [this.status?.textContent, ...items].filter(Boolean).join('\n');
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
		const iconPath = isDarkColorScheme(this.themes.getColorTheme().colorScheme) ? node.iconDark ?? node.icon : node.icon;
		const browserIcon = iconPath && ['http', 'https', 'data', 'blob'].includes(iconPath.scheme) ? iconPath : undefined;
		const markdownHover = lifetime.add(new MutableDisposable<ReturnType<IMarkdownRendererService['render']>>());
		const tooltip = typeof node.tooltip === 'object'
			? () => {
				markdownHover.value = this.markdown.render(node.tooltip as Exclude<ITreeItem['tooltip'], string | undefined>, { ownerDocument: row.ownerDocument });
				return markdownHover.value.element;
			}
			: node.tooltip ?? node.resourceUri?.fsPath ?? node.label?.label ?? node.handle;
		const label = lifetime.add(new IconLabel(row, {
			label: node.label?.label ?? node.handle, description: node.description, title: tooltip,
			matches: node.label?.highlights?.map(([start, end]) => ({ start, end })),
			icon: node.themeIcon, iconPath: node.themeIcon ? undefined : browserIcon,
			renderIcon: !node.themeIcon && !browserIcon && (iconPath || node.resourceUri) ? container => {
				if (!iconPath) { this.resourceIcons.renderFileIcon(node.resourceUri!, container); return; }
				// Package and remote resources pass through the file owner instead of file:// in Chromium.
				void this.files.readFileBytes(iconPath).then(file => {
					if (lifetime.isDisposed) { return; }
					if (file.bytes.byteLength > 1048576) { throw new RangeError('Tree icon exceeds 1 MiB'); }
					const blob = new Blob([Uint8Array.from(file.bytes).buffer], { type: getMediaMime(iconPath.path) ?? 'application/octet-stream' });
					const resource = createObjectUrl(row.ownerDocument.defaultView!, blob);
					lifetime.add(resource.registration);
					const image = h(row.ownerDocument, 'img');
					image.className = 'ash-icon-label-image';
					image.alt = '';
					image.src = resource.url.toString();
					container.append(image);
				}).catch(() => {
					if (!lifetime.isDisposed && node.resourceUri) { this.resourceIcons.renderFileIcon(node.resourceUri, container); }
				});
			} : undefined,
		}));
		label.element.classList.add('ash-custom-tree-content');
		label.labelElement.classList.add('ash-custom-tree-label');
		const scope = lifetime.add(this.contextKeys.getContextKeyService(this.container!).createScoped(row));
		scope.createKey('view', this.id);
		scope.createKey('viewItem', node.contextValue ?? '');
		const menu = lifetime.add(this.menus.createMenu(MenuId.for('view/item/context'), scope));
		const actions = lifetime.add(new ActionBar(row, {
			ariaLabel: localize('treeView.itemActions', 'Item actions'),
			actionViewItemOptions: { buttonClassName: 'ash-custom-tree-action' },
		}));
		lifetime.add(addDisposableListener(actions.domNode, 'click', event => event.stopPropagation()));
		lifetime.add(addDisposableListener(actions.domNode, 'keydown', event => event.stopPropagation()));
		lifetime.add(actions.onDidRun(event => { if (event.error) { this.notifications.error(String(event.error)); } }));
		const updateActions = () => actions.setActions(getActionBarActions(menu.getActions({ arg: { viewId: this.id, handle: node.handle } }), 'inline').primary);
		lifetime.add(menu.onDidChange(updateActions));
		updateActions();
		return row;
	}
}

/** The pane owns mounting and visibility; the extension binding owns the retained tree. */
export class TreeViewPane extends ViewPane {
	private titleMenu: IMenu | undefined;
	constructor(protected readonly treeView: TreeView, container: HTMLElement, options: IViewPaneOptions,
		@IMenuService menus: IMenuService,
		@IContextKeyService contexts: IContextKeyService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super(container, options);
		const scope = this._register(contexts.createScoped(this.element));
		scope.createKey('view', treeView.id);
		this.titleMenu = this._register(menus.createMenu(MenuId.for('view/title'), scope));
		this._register(this.titleMenu.onDidChange(() => this.updateTitleArea()));
		const badge = h(container.ownerDocument, 'span');
		badge.className = 'ash-custom-tree-badge';
		this.titleElement.after(badge);
		const updateTitle = () => {
			this.setTitle(treeView.title);
			this.updateTitleDescription(treeView.description);
			badge.hidden = !treeView.badge;
			badge.textContent = treeView.badge ? String(treeView.badge.value) : '';
			badge.title = treeView.badge?.tooltip ?? '';
			badge.setAttribute('aria-label', treeView.badge?.tooltip ?? '');
			this.updateTitleArea();
		};
		this._register(treeView.onDidChangeActions(updateTitle));
		this._register(treeView.onDidChangeWelcomeState(() => this.viewWelcomeState.fire()));
		updateTitle();
		const loading = this._register(new MutableDisposable());
		this._register(treeView.onDidChangeLoading(active => {
			if (active && !loading.value) {
				const progress = this.getProgressIndicator().show(true, 150);
				loading.value = toDisposable(() => progress.done());
			} else if (!active) loading.clear();
		}));
		treeView.show(this.contentElement);
		const welcome = this._register(instantiation.createInstance(ViewWelcomeController, this.contentElement, this, ViewsRegistry));
		welcome.update();
		this._register(toDisposable(() => treeView.hide()));
		this._register(this.onDidChangeBodyVisibility(visible => treeView.setVisibility(visible)));
	}
	public override getActions(): readonly IAction[] {
		return [...this.treeView?.getActions() ?? [], ...this.titleActions().primary];
	}
	public override getSecondaryActions(): readonly IAction[] { return this.titleActions().secondary; }
	private titleActions() {
		return getActionBarActions(this.titleMenu?.getActions({ arg: { viewId: this.id } }) ?? [], 'navigation');
	}
	public override shouldShowWelcome(): boolean { return this.treeView?.isEmpty ?? false; }
	public override focus(): void { this.treeView.focus(); }
	public override getOptimalWidth(): number { return this.treeView.getOptimalWidth(); }
	protected override layoutBody(height: number, width: number): void { this.treeView.layout(height, width); }
}
