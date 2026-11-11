import { h, type IDimension } from '../../../../base/browser/dom.js';
import { Orientation } from '../../../../base/browser/ui/sash/sash.js';
import { SplitView } from '../../../../base/browser/ui/splitview/splitview.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { basename, dirname, extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { MultiDiffEditorWidget } from '../../../../editor/browser/widget/multiDiffEditor/multiDiffEditorWidget.js';
import { localize } from '../../../../nls.js';
import { getFlatContextMenuActions } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { MultiDiffEditorFileListContextMenu, MultiDiffEditorFileListFocusedContext, type MultiDiffEditorFileListViewMode } from '../common/multiDiffEditor.js';
import { MultiDiffEditorFileList, type IMultiDiffEditorFileListItem } from './multiDiffEditorFileList.js';
import { multiDiffEditorItemKey, type MultiDiffEditorInputItem } from './multiDiffEditorInput.js';

interface IMultiDiffFile extends IMultiDiffEditorFileListItem {
	readonly item: MultiDiffEditorInputItem;
}

/** Composes the same diff widget with an optional, resizable Workbench file navigator. */
export class MultiDiffEditorWithFileListWidget extends Disposable {
	private static readonly MIN_DIFF_WIDTH = 300;
	private static readonly MIN_LIST_WIDTH = 180;
	private readonly split: SplitView;
	private readonly fileList = this._register(new MutableDisposable<DisposableStore & { readonly list: MultiDiffEditorFileList<IMultiDiffFile>; }>());
	private readonly listContainer: HTMLElement;
	private items: readonly MultiDiffEditorInputItem[] = [];
	private enabled = false;
	private viewMode: MultiDiffEditorFileListViewMode = 'list';
	private visible = false;
	private dimension: IDimension = { width: 0, height: 0 };

	constructor(
		container: HTMLElement,
		diffContainer: HTMLElement,
		private readonly editor: MultiDiffEditorWidget,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IMenuService private readonly menus: IMenuService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) {
		super();
		this.listContainer = h(container.ownerDocument, 'div', { className: 'ash-multi-diff-file-list' });
		this.split = this._register(new SplitView(container, { orientation: Orientation.HORIZONTAL, proportionalLayout: false }));
		const widget = this;
		this.split.addView({
			element: diffContainer, maximumSize: Infinity,
			get minimumSize() { return widget.visible ? MultiDiffEditorWithFileListWidget.MIN_DIFF_WIDTH : 0; },
			layout: (width, _offset, height) => editor.layout({ width, height }),
		}, 0);
		this.split.addView({
			element: this.listContainer, minimumSize: MultiDiffEditorWithFileListWidget.MIN_LIST_WIDTH, maximumSize: Infinity,
			layout: (width, _offset, height) => this.fileList.value?.list.tree.layout(height, width),
		}, 240);
		this.split.setViewVisible(1, false);
	}

	setItems(items: readonly MultiDiffEditorInputItem[]): void {
		this.items = items;
		this.updateFileList();
		this.layout(this.dimension);
	}

	setFileListState(enabled: boolean, viewMode: MultiDiffEditorFileListViewMode): void {
		if (this.enabled === enabled && this.viewMode === viewMode) return;
		this.enabled = enabled;
		if (this.viewMode !== viewMode) {
			this.viewMode = viewMode;
			if (enabled) this.updateFileList();
		}
		this.layout(this.dimension);
	}

	layout(dimension: IDimension): void {
		this.dimension = dimension;
		const visible = this.enabled && this.items.length > 0
			&& dimension.width >= MultiDiffEditorWithFileListWidget.MIN_DIFF_WIDTH + MultiDiffEditorWithFileListWidget.MIN_LIST_WIDTH;
		if (visible !== this.visible) {
			this.visible = visible;
			if (visible) {
				this.mountFileList();
				this.updateFileList();
			} else {
				if (this.listContainer.contains(this.listContainer.ownerDocument.activeElement)) this.editor.focus();
				this.fileList.clear();
			}
			this.split.setViewVisible(1, visible);
		}
		this.split.layout(dimension.width, dimension.height);
	}

	private mountFileList(): void {
		const list = this.instantiation.createInstance(MultiDiffEditorFileList<IMultiDiffFile>, this.listContainer, {
			ariaLabel: localize('multiDiff.changedFiles', 'Changed Files'),
			openOnSingleClick: true, expandOnlyOnTwistieClick: true, scrolling: 'managed',
			group: (file: IMultiDiffFile) => file.item.fileList?.group,
		});
		const resources = new DisposableStore();
		this.fileList.value = Object.assign(resources, { list: resources.add(list) });
		const tree = list.tree;
		const context = resources.add(this.contextKeys.createScoped(tree.element));
		MultiDiffEditorFileListFocusedContext.bindTo(context).set(true);
		resources.add(tree.onDidOpen(({ element, browserEvent, editorOptions }) => {
			if (element.type === 'folder') {
				if ('key' in browserEvent && (browserEvent.key === 'Enter' || browserEvent.key === ' ')) tree.toggleCollapsed(element.id);
				return;
			}
			if (tree.selection.length > 1 && !('key' in browserEvent)) return;
			const { original, modified } = element.item;
			this.editor.reveal({ original: original.resource, modified: modified.resource }, { highlight: false });
			if (!editorOptions.preserveFocus) this.editor.focus();
		}));
		resources.add(tree.onContextMenu(({ anchor, element }) => {
			if (element?.type !== 'file') return;
			tree.domFocus();
			const selection = tree.selection.includes(element) ? tree.selection : [element];
			const items = selection.flatMap(row => row.type === 'file' ? [row.item] : []);
			const actions = getFlatContextMenuActions(this.menus.getMenuActions(MultiDiffEditorFileListContextMenu, { arg: items }, context));
			if (actions.length) this.contextMenus.showContextMenu({ getAnchor: () => anchor, getActions: () => actions });
		}));
	}

	private updateFileList(): void {
		const list = this.fileList.value?.list;
		if (!list) return;
		const roots = new Map<string, URI>();
		const entries = this.items.map(item => {
			const resource = item.modified.preferredResource ?? item.goToFile?.resource ?? item.modified.resource;
			const pathResource = resource.with({ query: null, fragment: null });
			const workspaceRoot = this.workspace.getWorkspaceFolder(pathResource)?.uri;
			const rootKey = JSON.stringify([resource.scheme, resource.authority]);
			if (!item.fileList && !workspaceRoot) {
				let root = roots.get(rootKey) ?? dirname(pathResource);
				while (!extUriBiasedIgnorePathCase.isEqualOrParent(pathResource, root)) {
					const parent = dirname(root);
					if (parent.path === root.path) break;
					root = parent;
				}
				roots.set(rootKey, root);
			}
			return { item, resource, pathResource, workspaceRoot, rootKey };
		});
		list.setFiles(entries.map(({ item, resource, pathResource, workspaceRoot, rootKey }) => {
			const root = workspaceRoot ?? roots.get(rootKey);
			const relative = root && extUriBiasedIgnorePathCase.isEqualOrParent(pathResource, root)
				? pathResource.path.split('/').slice(root.path.replace(/\/+$/u, '').split('/').length).join('/') : undefined;
			const path = item.fileList?.path ?? (relative || basename(resource));
			return { type: 'file', id: multiDiffEditorItemKey(item), item, resource, path, label: this.viewMode === 'tree' || item.label === path ? undefined : item.label };
		}), this.viewMode);
	}
}
