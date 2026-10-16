import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import type { IAsyncDataTreeViewState } from '../../../../../base/browser/ui/tree/asyncDataTree.js';
import { isRecord } from '../../../../../base/common/types.js';
import { listRowHeight } from '../../../../../base/common/uiSizes.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { CancellationTokenSource, type CancellationToken } from '../../../../../base/common/cancellation.js';
import { EditorOpenSource } from '../../../../../platform/editor/common/editor.js';
import { IConfigurationService } from "../../../../../platform/configuration/common/configuration.js";
import { FileKind, IFileService } from "../../../../../platform/files/common/files.js";
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { IWorkspaceContextService } from "../../../../../platform/workspace/common/workspace.js";
import { IResourceIconRenderer } from "../../../../browser/labels.js";
import { ListConfiguration, WorkbenchCompressibleAsyncDataTree, type ResourceOpenEvent, type TreeExpandMode } from "../../../../../platform/list/browser/listService.js";
import { IEditorService } from "../../../../services/editor/common/editorService.js";
import { ViewPane, type IViewPaneOptions } from "../../../../browser/parts/views/viewPane.js";
import { addDisposableListener, h } from "../../../../../base/browser/dom.js";
import { appendIcon } from "../../../../../base/browser/ui/lxicons/lxicon.js";
import { Lxicon } from "../../../../../base/common/lxicons.js";
import { isMacintosh } from '../../../../../base/common/platform.js';
import { ExplorerItem } from "../../common/explorerModel.js";
import { ExplorerFileNestingSettingId } from '../../common/explorerFileNestingTrie.js';
import { ExplorerDataSource, ExplorerFindProvider, FileDragAndDrop, FileSorter, FilesRenderer } from "./explorerViewer.js";
import { dirname, extUriBiasedIgnorePathCase } from "../../../../../base/common/resources.js";
import { IExplorerService, type IExplorerView } from '../files.js';
import { ExplorerFocusedContext } from '../files.js';
import { IContextKeyService, type IScopedContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import type { IContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IMenuService, MenuId, type IMenu } from '../../../../../platform/actions/common/actions.js';
import { getActionBarActions } from '../../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { WorkbenchToolBar } from '../../../../../platform/actions/browser/toolbar.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { explorerFileContribRegistry } from '../explorerFileContrib.js';
import { AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { localize } from '../../../../../nls.js';
import { MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { FileEditorInput } from '../editors/fileEditorInput.js';
import { ResourceSchemeContext } from '../../../../common/contextkeys.js';
import { PASTE_FILE_COMMAND_ID } from '../fileActions.js';
import type { URI } from '../../../../../base/common/uri.js';

/** Workspace file tree backed by `IFileService` and the Workbench editor. */
export class ExplorerView extends ViewPane implements IExplorerView {
	private readonly fileService: IFileService;
	private readonly workspaceContextService: IWorkspaceContextService;
	private readonly editorService: IEditorService;
	private readonly explorerService: IExplorerService;
	private readonly tree: WorkbenchCompressibleAsyncDataTree<ExplorerItem, ExplorerItem>;
	private readonly scrollContent: HTMLDivElement;
	private statusDomNode: HTMLDivElement | undefined;
	private root: ExplorerItem | undefined;
	private viewStateWorkspaceId: string | undefined;
	private static readonly TREE_VIEW_STATE_STORAGE_KEY = 'workbench.explorer.treeViewState';
	private error: string | undefined;
	private treeError = false;
	private treeErrorElement: ExplorerItem | undefined;
	private workspaceGeneration = 0;
	private readonly selectionCancellation = this._register(new MutableDisposable<CancellationTokenSource>());
	private initialization: Promise<void>;
	private fileChangeProcessing: Promise<void> = Promise.resolve();
	private readonly loadedNests = new Set<string>();
	private readonly scopedContext: IScopedContextKeyService;
	private readonly hasContextResource: IContextKey<boolean>;
	private readonly contextIsFile: IContextKey<boolean>;
	private readonly contextCanModify: IContextKey<boolean>;
	private readonly contextCanCreate: IContextKey<boolean>;
	private compressedFocusIndex = 0;
	private readonly hasCutFiles: IContextKey<boolean>;
	private readonly titleMenu: IMenu;
	private readonly titleActions = this._register(new MutableDisposable<WorkbenchToolBar>());

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		@IFileService fileService: IFileService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@IEditorService editorService: IEditorService,
		@IResourceIconRenderer resourceIconRenderer: IResourceIconRenderer,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExplorerService explorerService: IExplorerService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IAccessibleViewService accessibleViewService: IAccessibleViewService,
		@IContextMenuService protected readonly contextMenuService: IContextMenuService,
		@ICommandService protected readonly commandService: ICommandService,
		@IStorageService private readonly storageService: IStorageService,
		@IMenuService menuService: IMenuService,
	) {
		super(container, options);
		this._register(toDisposable(() => this.selectionCancellation.value?.cancel()));
		this._register(storageService.onWillSaveState(() => this.saveTreeState()));
		this._register(explorerService.registerView(this));
		this.fileService = fileService;
		this.workspaceContextService = workspaceContextService;
		this.editorService = editorService;
		this.explorerService = explorerService;
		const renderer = this._register(instantiationService.createInstance(FilesRenderer, container.ownerDocument));
		this.element.classList.add("ash-explorer-view-pane");
		this.headerElement.classList.add("ash-explorer-title");
		this.contentElement.classList.add("ash-explorer");
		this.scrollContent = h(container.ownerDocument, 'div');
		this.scrollContent.className = 'ash-explorer-scroll-content';
		this.contentElement.append(this.scrollContent);
		const sorter = instantiationService.createInstance(FileSorter);
		const dataSource = this._register(instantiationService.createInstance(ExplorerDataSource, sorter));
		this.tree = this._register(new WorkbenchCompressibleAsyncDataTree<ExplorerItem, ExplorerItem>(this.scrollContent, dataSource, {
			ariaLabel: localize('accessibility.explorerTreeLabel', 'Workspace files'),
			multipleSelectionSupport: true,
			dnd: this._register(instantiationService.createInstance(FileDragAndDrop, (error: unknown) => {
				if (this.isDisposed) return;
				this.error = error instanceof Error ? error.message : String(error);
				this.render();
			}, (items: readonly ExplorerItem[]) => {
				const focused = this.tree.focus;
				const segment = focused && this.tree.getCompressedTreeNode(focused)?.elements[this.compressedFocusIndex];
				return items.map(item => item === focused && segment ? segment : item);
			})),
			scrolling: "managed",
			configurationService,
			getHeight: () => listRowHeight,
			findMode: 'filter',
			compressionEnabled: configurationService.getValue<boolean>('explorer.compactFolders'),
			// Keep workspace roots and their immediate children out of eager compact-chain resolution.
			isIncompressible: item => item.kind !== FileKind.Directory || workspaceContextService.getWorkspace().folders.some(folder =>
				extUriBiasedIgnorePathCase.isEqual(folder.uri, item.resource) || extUriBiasedIgnorePathCase.isEqual(folder.uri, dirname(item.resource))),
			collapseByDefault: item => item.kind !== FileKind.File,
			expandOnlyOnTwistieClick: () => configurationService.getValue<TreeExpandMode>(ListConfiguration.treeExpandMode) === "doubleClick",
			identityProvider: { getId: (node) => node.resource.toString() },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: item => item.name, getCompressedNodeKeyboardNavigationLabel: elements => elements.map(item => item.name).join('/') },
			openOnSingleClick: true,
			reuseRows: true,
			onDidRemoveRow: row => renderer.disposeRow(row),
			renderCompressedElements: items => renderer.renderCompressedElements(items),
			renderTwistie: (_item, state, twistie) => {
				if (state.loading) {
					const loading = h(twistie.ownerDocument, "span");
					loading.className = "ash-explorer-tree-loading";
					twistie.append(loading);
				} else if (state.collapsible) appendIcon(state.expanded ? Lxicon.chevronDown : Lxicon.chevronRight, twistie);
			},
		}));
		const updateTwistieLayout = () => {
			const theme = resourceIconRenderer.getFileIconTheme();
			// Without folder icons, a file icon occupies the same column as a folder arrow.
			this.tree.updateOptions({
				twistieAdditionalCssClass: item => {
					// Nested file groups keep their arrow even when the theme hides directory arrows.
					if (item.kind !== FileKind.Directory && item.children?.length) {
						return 'ash-tree-twistie-with-icon-gap';
					}
					const hideTwistie = theme.hidesExplorerArrows || theme.hasFileIcons && !theme.hasFolderIcons && item.kind !== FileKind.Directory;
					return hideTwistie ? 'ash-tree-twistie-hidden' : 'ash-tree-twistie-with-icon-gap';
				}
			});
		};
		updateTwistieLayout();
		this._register(resourceIconRenderer.onDidChangeResourceIcons(updateTwistieLayout));
		this._register(new ExplorerFindProvider(this.tree, this.headerElement));
		this.scopedContext = this._register(contextKeyService.createScoped(this.element));
		this.scopedContext.setContext('view', options.id);
		this.titleMenu = this._register(menuService.createMenu(MenuId.for('ViewTitle'), this.scopedContext));
		this._register(this.titleMenu.onDidChange(() => {
			this.renderHeaderActions();
			this.updateTitleArea();
		}));
		this.headerActionsElement.setAttribute('aria-label', localize('files.explorerActions', 'Explorer Actions'));
		this.renderHeaderActions();
		ExplorerFocusedContext.bindTo(this.scopedContext).set(true);
		this.hasContextResource = this.scopedContext.createKey<boolean>('ashExplorerHasResource', false);
		this.contextIsFile = this.scopedContext.createKey<boolean>('ashExplorerIsFile', false);
		this.contextCanModify = this.scopedContext.createKey<boolean>('ashExplorerCanModify', false);
		this.contextCanCreate = this.scopedContext.createKey<boolean>('ashExplorerCanCreate', false);
		this.hasCutFiles = this.scopedContext.createKey<boolean>('ashExplorerHasCutFiles', explorerService.getToCopy().cut);
		this._register(explorerService.onDidChangeClipboard(() => {
			const clipboard = explorerService.getToCopy();
			this.hasCutFiles.set(clipboard.cut);
			if (clipboard.items.length) status(clipboard.cut
				? localize('accessibility.explorerCut', '{0} items ready to move.', clipboard.items.length)
				: localize('accessibility.explorerCopy', '{0} items ready to copy.', clipboard.items.length));
		}));
		this._register(this.tree.onDidChangeFocus(({ elements, browserEvent }) => {
			if (browserEvent) this.selectionCancellation.value?.cancel();
			this.compressedFocusIndex = Math.max(0, elements.length - 1);
			this.updateCompressedFocus();
		}));
		this._register(this.tree.onPointer(event => {
			const segment = event.browserEvent.target instanceof Element ? event.browserEvent.target.closest<HTMLElement>('[data-explorer-segment]') : null;
			if (segment) {
				this.compressedFocusIndex = Number(segment.dataset.explorerSegment);
				this.updateCompressedFocus();
			}
		}));
		this._register(this.tree.onDidChangeSelection(({ browserEvent }) => {
			if (browserEvent) this.selectionCancellation.value?.cancel();
			this.updateExplorerContextKeys(this.getContext()[0]);
		}));
		this._register(addDisposableListener(this.tree.domNode, 'keydown', event => {
			if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !this.tree.focus) return;
			const items = this.tree.getCompressedTreeNode(this.tree.focus)?.elements ?? [];
			const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
			const index = this.compressedFocusIndex + direction;
			if (!direction || items.length < 2 || index < 0 || index >= items.length) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			this.compressedFocusIndex = index;
			this.updateCompressedFocus();
		}, true));
		this._register(addDisposableListener(this.tree.domNode, 'contextmenu', event => this.showExplorerContextMenu(event)));
		let pendingKeyboardPaste: ReturnType<typeof setTimeout> | undefined;
		let pendingMovePaste = false;
		this._register(toDisposable(() => clearTimeout(pendingKeyboardPaste)));
		const paste = (files?: FileList, moveRequested = false): void => {
			void this.commandService.executeCommand(PASTE_FILE_COMMAND_ID, files, moveRequested).catch(error => {
				this.error = error instanceof Error ? error.message : String(error);
				this.render();
			});
		};
		this._register(addDisposableListener(this.tree.domNode, 'paste', event => {
			clearTimeout(pendingKeyboardPaste);
			pendingKeyboardPaste = undefined;
			event.preventDefault();
			paste(event.clipboardData?.files, pendingMovePaste);
			pendingMovePaste = false;
		}));
		this._register(addDisposableListener(this.tree.domNode, 'keydown', event => {
			const moveRequested = isMacintosh && event.metaKey && event.altKey && !event.ctrlKey;
			if (event.key.toLowerCase() === 'v' && !event.shiftKey && (moveRequested || ((event.ctrlKey || event.metaKey) && !event.altKey))) {
				clearTimeout(pendingKeyboardPaste);
				pendingMovePaste = moveRequested;
				// Finder keeps copied files on the clipboard; this shortcut supplies the move intent.
				if (moveRequested) event.preventDefault();
				// A browser paste event carries files from the system file manager. If it arrives,
				// it owns this shortcut; otherwise the command reads Ash resources from the clipboard.
				pendingKeyboardPaste = setTimeout(() => {
					pendingKeyboardPaste = undefined;
					paste(undefined, pendingMovePaste);
					pendingMovePaste = false;
				}, 0);
			}
			if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) this.showExplorerContextMenu(event);
		}));
		const updateAriaLabel = () => {
			const label = localize('accessibility.explorerTreeLabel', 'Workspace files');
			const hint = accessibleViewService.getOpenAriaHint(AccessibilityVerbositySettingId.Explorer);
			this.tree.element.setAttribute('aria-label', hint ? `${label}. ${hint}` : label);
		};
		updateAriaLabel();
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.Explorer)) updateAriaLabel();
			if (event.affectsConfiguration('explorer.compactFolders')) this.tree.updateOptions({ compressionEnabled: configurationService.getValue<boolean>('explorer.compactFolders') });
			if (event.affectsConfiguration('explorer.compactFolders') || event.affectsConfiguration('files.exclude') || event.affectsConfiguration('explorer.sortOrder') || event.affectsConfiguration('explorer.sortOrderLexicographicOptions') || event.affectsConfiguration('explorer.sortOrderReverse') || event.affectsConfiguration('explorer.decorations') || event.affectsConfiguration(ExplorerFileNestingSettingId.Enabled) || event.affectsConfiguration(ExplorerFileNestingSettingId.Patterns)) {
				const roots = this.root?.children ?? (this.root ? [this.root] : []);
				for (const root of roots) void this.refreshRoot(root);
			}
		}));
		this._register(this.tree.onDidError(({ element, error }) => {
			this.treeError = true;
			this.treeErrorElement = element;
			this.error = error instanceof Error ? error.message : "Unable to read workspace files.";
			this.render();
		}));
		this._register(this.tree.onDidOpen((event) => {
			if (event.element.kind === FileKind.File) void this.openFile(event);
		}));
		this._register(this.tree.onDidChangeLoadState(({ element, loading, error }) => {
			if (!loading) {
				const retriedFailedElement = element === undefined
					? this.treeErrorElement === undefined
					: this.treeErrorElement !== undefined && extUriBiasedIgnorePathCase.isEqual(element.resource, this.treeErrorElement.resource);
				if (error === undefined && this.treeError && retriedFailedElement) {
					this.treeError = false;
					this.treeErrorElement = undefined;
					this.error = undefined;
					this.render();
				}
				this.loadVisibleFileNests();
			}
		}));
		this._register(explorerFileContribRegistry.onDidRegisterDescriptor(() => {
			const roots = this.root?.children ?? (this.root ? [this.root] : []);
			for (const root of roots) void this.refreshRoot(root);
		}));
		this._register(explorerService.onDidChangeRoot(() => { this.initialization = this.initialize(); }));
		this._register(explorerService.onDidChangeResources(resources => {
			const generation = this.workspaceGeneration;
			this.fileChangeProcessing = this.fileChangeProcessing.then(async () => {
				await this.initialization;
				if (this.isDisposed || generation !== this.workspaceGeneration) return;
				await this.refreshChangedResources(resources, generation);
			}).catch(error => {
				if (!this.isDisposed && generation === this.workspaceGeneration) console.error('Could not process Explorer file changes', error);
			});
		}));
		this.render();
		this.initialization = this.initialize();
		const revealActiveEditor = (options: { readonly revealSelectedResource?: boolean; } = {}): void => {
			const token = this.startSelection();
			if (!this.isBodyVisible()) return;
			const resource = editorService.activeEditor?.resource;
			if (!resource || !workspaceContextService.getWorkspaceFolder(resource)) return;
			void this.autoReveal(resource, token, options).catch(error => {
				if (!this.isDisposed && !token.isCancellationRequested && !isCancellationError(error)) console.error('Could not reveal the active editor', error);
			});
		};
		this._register(editorService.onDidActiveEditorChange(() => revealActiveEditor()));
		this._register(this.onDidChangeBodyVisibility(visible => {
			// Hidden trees have no usable viewport for revealing the active file.
			if (visible) revealActiveEditor({ revealSelectedResource: true });
			else this.selectionCancellation.value?.cancel();
		}));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('explorer.autoReveal') || event.affectsConfiguration('explorer.autoRevealExclude')) revealActiveEditor();
		}));
		revealActiveEditor();
		this._register(toDisposable(() => this.saveTreeState()));
	}

	private startSelection(): CancellationToken {
		this.selectionCancellation.value?.cancel();
		const source = new CancellationTokenSource();
		this.selectionCancellation.value = source;
		return source.token;
	}

	private async autoReveal(resource: URI, token: CancellationToken, options: { readonly revealSelectedResource?: boolean; } = {}): Promise<void> {
		await this.initialization;
		if (this.isDisposed || token.isCancellationRequested) return;
		if (!options.revealSelectedResource) {
			if (this.tree.focus && extUriBiasedIgnorePathCase.isEqual(this.tree.focus.resource, resource) && this.tree.selection.length === 1 && extUriBiasedIgnorePathCase.isEqual(this.tree.selection[0]!.resource, resource)) return;
			// A delayed preview activation must not undo subsequent keyboard name navigation.
			if (this.hasFocus() && this.tree.selection.some(item => extUriBiasedIgnorePathCase.isEqual(item.resource, resource))) return;
		}
		let needsSiblings = false;
		if (!this.explorerService.shouldAutoReveal(resource, () => { needsSiblings = true; return false; })) return;
		if (needsSiblings) {
			const siblings = await this.resolveSiblings(resource, token);
			if (this.isDisposed || token.isCancellationRequested || !this.explorerService.shouldAutoReveal(resource, name => hasSibling(siblings, name))) return;
		}
		await this.doSelectResource(resource, token, this.configurationService.getValue<boolean | 'focusNoScroll'>('explorer.autoReveal') !== 'focusNoScroll');
	}

	private async resolveSiblings(resource: URI, token: CancellationToken): Promise<readonly ExplorerItem[]> {
		const generation = this.workspaceGeneration;
		const parent = dirname(resource);
		let item = this.tree.getVisibleElements().find(candidate => candidate.kind === FileKind.Directory && extUriBiasedIgnorePathCase.isEqual(candidate.resource, parent)) ?? this.root;
		while (item && !this.isDisposed && generation === this.workspaceGeneration && !token.isCancellationRequested) {
			if (!containsResource(item, parent)) return [];
			let children = this.tree.getNode(item).children;
			if (children === undefined || this.tree.isLoading(item)) {
				// Resolve directory data without expanding an excluded folder or refreshing cached siblings.
				await this.tree.updateChildren(item, { recursive: false });
				if (this.isDisposed || generation !== this.workspaceGeneration || token.isCancellationRequested) return [];
				children = this.tree.getNode(item).children;
			}
			const siblings = children?.map(child => child.element) ?? [];
			if (extUriBiasedIgnorePathCase.isEqual(item.resource, parent)) return siblings;
			item = siblings.find(child => child.kind === FileKind.Directory && containsResource(child, parent));
		}
		return [];
	}

	public selectResource(resource: URI | undefined, reveal: boolean | string = true): Promise<void> {
		if (reveal) this.setExpanded(true);
		return this.doSelectResource(resource, this.startSelection(), !!reveal);
	}

	private async doSelectResource(resource: URI | undefined, token: CancellationToken, reveal = true): Promise<void> {
		const generation = this.workspaceGeneration;
		await this.initialization;
		if (this.isDisposed || generation !== this.workspaceGeneration || token.isCancellationRequested) return;
		if (!resource) {
			this.tree.setSelection([]);
			return;
		}
		const expanded = new Set<string>();
		let closestDirectory: ExplorerItem | undefined;
		let refreshedMissingResource = false;
		// Only load ancestors of the requested file; nested file groups may contain sibling paths.
		while (!this.isDisposed && generation === this.workspaceGeneration && !token.isCancellationRequested) {
			const visibleItems = this.tree.getVisibleElements();
			const item = visibleItems.flatMap(candidate => this.tree.getCompressedTreeNode(candidate)?.elements ?? [candidate]).find(candidate => extUriBiasedIgnorePathCase.isEqual(candidate.resource, resource)) ?? visibleItems.find(candidate =>
				!expanded.has(extUriBiasedIgnorePathCase.getComparisonKey(candidate.resource)) && containsResource(candidate, resource));
			if (!item) {
				if (!closestDirectory || refreshedMissingResource) return;
				// A newly created file can be selected before its watcher notification reaches the tree.
				refreshedMissingResource = true;
				await this.tree.updateChildren(closestDirectory, { recursive: false });
				expanded.clear();
				continue;
			}
			if (extUriBiasedIgnorePathCase.isEqual(item.resource, resource)) {
				this.tree.setFocus(item);
				this.tree.setSelection([item]);
				if (reveal) this.tree.reveal(item, 0.5);
				return;
			}
			if (item.kind === FileKind.Directory) closestDirectory = item;
			expanded.add(extUriBiasedIgnorePathCase.getComparisonKey(item.resource));
			await this.tree.expand(item);
		}
	}

	public getContext(): readonly ExplorerItem[] {
		const focus = this.tree.focus;
		const segment = focus && this.tree.getCompressedTreeNode(focus)?.elements[this.compressedFocusIndex];
		return this.tree.selection.map(item => item === focus && segment ? segment : item);
	}

	public collapseAll(): void {
		this.tree.collapseAll();
	}

	public async refresh(recursive: boolean, item?: ExplorerItem): Promise<void> {
		await this.initialization;
		await this.fileChangeProcessing;
		if (this.isDisposed) { return; }
		const generation = this.workspaceGeneration;
		const roots = item ? [item] : this.root?.children ?? (this.root ? [this.root] : []);
		for (const root of roots) {
			if (this.isDisposed || generation !== this.workspaceGeneration) { return; }
			await this.refreshItem(root, recursive);
		}
	}

	public override getActions(): readonly IAction[] {
		if (this.partTitleProjection?.actions) { return []; }
		return getActionBarActions(this.titleMenu.getActions(), 'navigation').primary;
	}

	public override getSecondaryActions(): readonly IAction[] {
		if (this.partTitleProjection?.actions) { return []; }
		return getActionBarActions(this.titleMenu.getActions(), 'navigation').secondary;
	}

	public override setHeaderVisible(visible: boolean): void {
		super.setHeaderVisible(visible);
		this.renderHeaderActions();
	}

	private renderHeaderActions(): void {
		// A host-provided title surface owns its action renderer and command list.
		if (!this.isHeaderVisible() || this.partTitleProjection?.actions) {
			this.titleActions.clear();
			return;
		}
		if (!this.titleActions.value) {
			this.titleActions.value = new WorkbenchToolBar(this.headerActionsElement, this.contextMenuService, {
				ariaLabel: localize('files.explorerActions', 'Explorer Actions'),
			});
		}
		this.titleActions.value.setActions(this.getActions(), this.getSecondaryActions());
	}

	public getAccessibleContent(): string {
		const heading = localize('accessibility.explorerVisibleFiles', 'Visible workspace files');
		const operations = localize('accessibility.explorerFileOperations', 'Select files or folders, then use Ctrl or Command plus X to cut, C to copy, or V to paste. Press Escape to cancel a cut.');
		const files = this.tree.getVisibleElements().map(item =>
			`${item.kind === FileKind.Directory ? localize('accessibility.explorerFolder', 'Folder') : localize('accessibility.explorerFile', 'File')}: ${item.name}`);
		return [heading, operations, this.root?.name ?? '', ...files].filter(Boolean).join('\n');
	}

	public focus(): void {
		this.tree.domFocus();
	}

	public hasFocus(): boolean {
		return this.tree.element.contains(this.tree.element.ownerDocument.activeElement);
	}

	private findRenderedItem(resource: string | undefined): ExplorerItem | undefined {
		if (!this.root || !resource) return undefined;
		const queue = [this.root];
		while (queue.length) {
			const item = queue.pop()!;
			if (item.resource.toString() === resource) return item;
			for (const child of this.tree.getNode(item).children ?? []) queue.push(child.element as ExplorerItem);
		}
		return undefined;
	}

	private updateCompressedFocus(): void {
		this.tree.element.querySelectorAll('.ash-explorer-active-segment').forEach(segment => segment.classList.remove('ash-explorer-active-segment'));
		const focus = this.tree.focus;
		if (!focus) return;
		const items = this.tree.getCompressedTreeNode(focus)?.elements ?? [focus];
		this.compressedFocusIndex = Math.min(this.compressedFocusIndex, items.length - 1);
		const row = [...this.tree.element.querySelectorAll<HTMLElement>('.ash-tree-row')].find(row => row.querySelector<HTMLElement>('.ash-explorer-row-content')?.dataset.resource === focus.resource.toString());
		const segment = row?.querySelector<HTMLElement>(`[data-explorer-segment="${this.compressedFocusIndex}"]`);
		segment?.classList.add('ash-explorer-active-segment');
		if (row && items.length > 1) row.setAttribute('aria-label', localize('accessibility.explorerFolderSegment', '{0}, folder {1} of {2}', items[this.compressedFocusIndex]!.name, this.compressedFocusIndex + 1, items.length));
		this.updateExplorerContextKeys(this.getContext()[0]);
	}

	private showExplorerContextMenu(event: MouseEvent | KeyboardEvent): void {
		event.preventDefault();
		event.stopPropagation();
		const row = event.target instanceof Element ? event.target.closest<HTMLElement>('.ash-tree-row') : null;
		let item = event instanceof MouseEvent
			? this.findRenderedItem(row?.querySelector<HTMLElement>('.ash-explorer-row-content')?.dataset.resource)
			: this.tree.focus;
		if (item) {
			const segment = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-explorer-segment]') : null;
			const items = this.tree.getCompressedTreeNode(item)?.elements ?? [item];
			const index = segment ? Number(segment.dataset.explorerSegment) : item === this.tree.focus ? this.compressedFocusIndex : items.length - 1;
			this.tree.setFocus(item);
			this.compressedFocusIndex = index;
			if (!this.tree.selection.includes(item)) this.tree.setSelection([item]);
			this.updateCompressedFocus();
			item = items[index] ?? item;
		}
		this.updateExplorerContextKeys(item);
		const anchor = event instanceof MouseEvent
			? { x: event.clientX, y: event.clientY, targetWindow: this.element.ownerDocument.defaultView ?? undefined }
			: row ?? this.tree.element;
		this.contextMenuService.showContextMenu({
			menuId: MenuId.ExplorerContext,
			contextKeyService: this.scopedContext,
			menuActionOptions: { arg: item?.resource, shouldForwardArgs: true },
			getActionsContext: () => item ? this.getContext().map(selected => selected.resource) : [],
			getAnchor: () => anchor,
			onHide: didCancel => { if (didCancel) this.tree.domFocus(); },
		});
	}

	private updateExplorerContextKeys(item: ExplorerItem | undefined): void {
		const folder = item && this.workspaceContextService.getWorkspaceFolder(item.resource);
		const isRoot = item ? item.resource.scheme === 'ash-workspace' || !!folder && extUriBiasedIgnorePathCase.isEqual(folder.uri, item.resource) : false;
		this.hasContextResource.set(!!item);
		this.contextIsFile.set(item?.kind === FileKind.File);
		this.contextCanModify.set(!!item && !isRoot);
		this.contextCanCreate.set(item
			? item.kind === FileKind.Directory && item.resource.scheme !== 'ash-workspace'
			: this.workspaceContextService.getWorkspace().folders.length > 0);
		this.scopedContext.setContext(ResourceSchemeContext.key, item?.resource.scheme);
	}

	private async initialize(): Promise<void> {
		const generation = ++this.workspaceGeneration;
		this.viewStateWorkspaceId = undefined;
		this.loadedNests.clear();
		this.root = undefined;
		this.error = undefined;
		this.treeError = false;
		this.treeErrorElement = undefined;
		void this.tree.setInput(undefined);
		this.render();
		const workspace = this.workspaceContextService.getWorkspace();
		if (workspace.folders.length === 0) {
			this.error = "Open a folder to browse files.";
			this.render();
			return;
		}
		try {
			// Workspace folders are validated at the host boundary; the first directory read reports an invalid root.
			this.root = this.explorerService.getRoot();
			this.setTitle(workspace.folders.length === 1 ? this.root!.name : workspace.name ?? 'Explorer');
			await this.tree.setInput(this.root, this.readTreeState());
			if (this.isDisposed || generation !== this.workspaceGeneration) return;
			this.viewStateWorkspaceId = workspace.id;
			this.render();
		} catch (error) {
			if (this.isDisposed || generation !== this.workspaceGeneration) return;
			this.error = error instanceof Error
				? error.message
				: "Unable to load workspace files.";
			this.render();
		}
	}

	private saveTreeState(): void {
		if (this.viewStateWorkspaceId !== this.workspaceContextService.getWorkspace().id) return;
		this.storageService.store(ExplorerView.TREE_VIEW_STATE_STORAGE_KEY, JSON.stringify(this.tree.getViewState()), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private readTreeState(): IAsyncDataTreeViewState | undefined {
		const stored = this.storageService.get(ExplorerView.TREE_VIEW_STATE_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!stored) return undefined;
		try {
			const value: unknown = JSON.parse(stored);
			if (!isRecord(value)) return undefined;
			for (const key of ['focus', 'selection', 'expanded']) {
				if (value[key] !== undefined && (!Array.isArray(value[key]) || !value[key].every(id => typeof id === 'string'))) return undefined;
			}
			if (value.scrollTop !== undefined && (typeof value.scrollTop !== 'number' || !Number.isFinite(value.scrollTop) || value.scrollTop < 0)) return undefined;
			return value as IAsyncDataTreeViewState;
		} catch { return undefined; }
	}

	private async refreshChangedResources(resources: readonly URI[] | undefined, generation: number): Promise<void> {
		const roots = this.root?.children ?? (this.root ? [this.root] : []);
		for (const root of roots) {
			if (this.isDisposed || generation !== this.workspaceGeneration) return;
			const changed = resources?.filter(resource => extUriBiasedIgnorePathCase.isEqualOrParent(resource, root.resource));
			if (changed && changed.length === 0) continue;
			if (!changed || changed.some(resource => extUriBiasedIgnorePathCase.isEqual(resource, root.resource))) {
				await this.refreshItem(root, true);
				continue;
			}
			const items = new Map([root, ...this.tree.getVisibleElements()].map(item => [extUriBiasedIgnorePathCase.getComparisonKey(item.resource), item] as const));
			const targets = new Map<string, { item: ExplorerItem; recursive: boolean; }>();
			for (const resource of changed) {
				const key = extUriBiasedIgnorePathCase.getComparisonKey(resource);
				const item = items.get(key);
				// Watcher paths are coarse hints. Verify the existing entry before treating a change as content-only.
				// Exact spelling matters for case-only renames; the tree currently sorts by name, not metadata.
				// Bursts reconcile each affected directory once instead of sending one stat per changed file.
				if (this.configurationService.getValue<string>('explorer.sortOrder') !== 'modified' && changed.length === 1 && item?.kind === FileKind.File && item.resource.path === resource.path) {
					try {
						const stat = await this.fileService.stat(resource);
						if (stat.kind === FileKind.File) continue;
					} catch {
						// Deletion or an unavailable stat requires a directory read to reconcile the entry.
					}
				}
				if (this.isDisposed || generation !== this.workspaceGeneration) return;
				let directory: ExplorerItem | undefined;
				for (let ancestor = dirname(resource); ; ancestor = dirname(ancestor)) {
					const candidate = items.get(extUriBiasedIgnorePathCase.getComparisonKey(ancestor));
					if (candidate?.kind === FileKind.Directory) {
						directory = candidate;
						break;
					}
					if (extUriBiasedIgnorePathCase.isEqual(ancestor, root.resource)) break;
				}
				if (directory) {
					const directoryKey = extUriBiasedIgnorePathCase.getComparisonKey(directory.resource);
					if (!targets.has(directoryKey)) targets.set(directoryKey, { item: directory, recursive: false });
				}
				if (item?.kind === FileKind.Directory) targets.set(key, { item, recursive: true });
			}
			for (const target of targets.values()) {
				if (this.isDisposed || generation !== this.workspaceGeneration) return;
				let covered = false;
				for (let ancestor = dirname(target.item.resource); !extUriBiasedIgnorePathCase.isEqual(ancestor, target.item.resource); ancestor = dirname(ancestor)) {
					if (targets.get(extUriBiasedIgnorePathCase.getComparisonKey(ancestor))?.recursive) {
						covered = true;
						break;
					}
					if (extUriBiasedIgnorePathCase.isEqual(ancestor, root.resource) || extUriBiasedIgnorePathCase.isEqual(ancestor, dirname(ancestor))) break;
				}
				if (covered) continue;
				// A parent refresh may remove or replace this directory before its own target is reached.
				const item = target.item === this.root ? this.root : this.tree.getVisibleElements().find(candidate => extUriBiasedIgnorePathCase.isEqual(candidate.resource, target.item.resource));
				if (item?.kind === FileKind.Directory) await this.refreshItem(item, target.recursive);
			}
		}
	}

	private async refreshRoot(root: ExplorerItem): Promise<void> {
		await this.refreshItem(root, true);
	}

	private async refreshItem(item: ExplorerItem, recursive: boolean): Promise<void> {
		const generation = this.workspaceGeneration;
		this.loadedNests.clear();
		try {
			await this.tree.updateChildren(item, { recursive, deferIfCollapsed: true });
			if (generation !== this.workspaceGeneration || this.isDisposed) return;
			this.error = undefined;
			this.treeError = false;
			this.treeErrorElement = undefined;
			this.render();
		} catch (error) {
			if (generation !== this.workspaceGeneration || this.isDisposed) return;
			this.error = error instanceof Error ? error.message : "Unable to refresh workspace files.";
			this.treeError = true;
			this.treeErrorElement = item;
			this.render();
		}
	}

	private loadVisibleFileNests(): void {
		for (const item of this.tree.getVisibleElements()) {
			if (item.kind !== FileKind.File || !item.children?.length) {
				continue;
			}
			const key = extUriBiasedIgnorePathCase.getComparisonKey(item.resource);
			if (this.loadedNests.has(key)) {
				continue;
			}
			this.loadedNests.add(key);
			void this.tree.updateChildren(item);
		}
	}

	private async openFile(event: ResourceOpenEvent<ExplorerItem>): Promise<void> {
		const node = event.element;
		try {
			await this.editorService.openEditor(new FileEditorInput(node.resource, { label: node.name }), { ...event.editorOptions, source: EditorOpenSource.USER }, event.sideBySide ? "sideGroup" : "activeGroup");
		} catch (error) {
			if (!isCancellationError(error)) throw error;
		}
	}

	private render(): void {
		const document = this.element.ownerDocument;
		this.statusDomNode?.remove();
		this.statusDomNode = undefined;
		if (!this.root) {
			// Directory loading measures the virtual viewport, including during workspace switches.
			if (this.tree.domNode.parentElement !== this.scrollContent) this.scrollContent.append(this.tree.domNode);
			const status = h(document, "div");
			status.className = "ash-explorer-status";
			status.setAttribute("role", "status");
			status.textContent = this.error ?? "Loading files…";
			this.statusDomNode = status;
			this.scrollContent.prepend(status);
			return;
		}
		if (this.error) {
			const error = h(document, "div");
			error.className = "ash-explorer-status ash-explorer-error";
			error.setAttribute("role", "alert");
			error.textContent = this.error;
			this.statusDomNode = error;
			this.scrollContent.prepend(error);
		}
		// Keep the tree mounted across status updates so focus and scroll state survive refreshes.
		if (this.tree.domNode.parentElement !== this.scrollContent) this.scrollContent.append(this.tree.domNode);
	}

}

function hasSibling(items: readonly ExplorerItem[], name: string): boolean {
	return items.some(item => item.name === name || item.kind === FileKind.File && hasSibling(item.children ?? [], name));
}

function containsResource(item: ExplorerItem, resource: URI): boolean {
	return extUriBiasedIgnorePathCase.isEqual(item.resource, resource)
		|| item.kind === FileKind.Directory && extUriBiasedIgnorePathCase.isEqualOrParent(resource, item.resource)
		|| item.children?.some(child => containsResource(child, resource)) === true;
}
