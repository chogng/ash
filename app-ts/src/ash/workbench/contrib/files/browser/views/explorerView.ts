import { isCancellationError } from '../../../../../base/common/errors.js';
import { EditorOpenSource } from '../../../../../platform/editor/common/editor.js';
import { IConfigurationService } from "../../../../../platform/configuration/common/configuration.js";
import { FileKind, IFileService } from "../../../../../platform/files/common/files.js";
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { IWorkspaceContextService } from "../../../../../platform/workspace/common/workspace.js";
import { IResourceIconRenderer } from "../../../../browser/labels.js";
import { IHoverService } from "../../../../../platform/hover/browser/hoverService.js";
import { IDecorationsService } from "../../../../services/decorations/common/decorations.js";
import { ILabelService } from "../../../../../platform/label/common/labelService.js";
import { ListConfiguration, WorkbenchAsyncDataTree, type ResourceOpenEvent, type TreeExpandMode } from "../../../../../platform/list/browser/listService.js";
import { IEditorService } from "../../../../services/editor/common/editorService.js";
import { ViewPane, type IViewPaneOptions } from "../../../../browser/parts/views/viewPane.js";
import { addDisposableListener, h } from "../../../../../base/browser/dom.js";
import { appendIcon } from "../../../../../base/browser/ui/lxicons/lxicon.js";
import { Lxicon } from "../../../../../base/common/lxicons.js";
import { isMacintosh } from '../../../../../base/common/platform.js';
import { ExplorerItem } from "../../common/explorerModel.js";
import { ExplorerFileNestingSettingId } from '../../common/explorerFileNestingTrie.js';
import { ExplorerDataSource, ExplorerFindProvider, FileSorter, FilesRenderer } from "./explorerViewer.js";
import { dirname, extUriBiasedIgnorePathCase } from "../../../../../base/common/resources.js";
import { IExplorerService, type IExplorerView } from '../files.js';
import { ExplorerFocusedContext } from '../files.js';
import { IContextKeyService, type IScopedContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import type { IContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { MenuId } from '../../../../../platform/actions/common/actions.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { explorerFileContribRegistry } from '../explorerFileContrib.js';
import { AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { localize } from '../../../../../nls.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
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
	private readonly tree: WorkbenchAsyncDataTree<ExplorerItem, ExplorerItem>;
	private readonly scrollContent: HTMLDivElement;
	private statusDomNode: HTMLDivElement | undefined;
	private root: ExplorerItem | undefined;
	private error: string | undefined;
	private treeError = false;
	private treeErrorElement: ExplorerItem | undefined;
	private workspaceGeneration = 0;
	private initialization: Promise<void>;
	private readonly loadedNests = new Set<string>();
	private readonly scopedContext: IScopedContextKeyService;
	private readonly hasContextResource: IContextKey<boolean>;
	private readonly contextIsFile: IContextKey<boolean>;
	private readonly contextCanModify: IContextKey<boolean>;
	private readonly contextCanCreate: IContextKey<boolean>;
	private readonly hasCutFiles: IContextKey<boolean>;

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		@IFileService fileService: IFileService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@IEditorService editorService: IEditorService,
		@IResourceIconRenderer resourceIconRenderer: IResourceIconRenderer,
		@IHoverService hoverService: IHoverService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExplorerService explorerService: IExplorerService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IAccessibleViewService accessibleViewService: IAccessibleViewService,
		@IContextMenuService protected readonly contextMenuService: IContextMenuService,
		@ICommandService protected readonly commandService: ICommandService,
		@IDecorationsService decorationsService: IDecorationsService,
		@ILabelService labelService?: ILabelService,
	) {
		super(container, options);
		this._register(explorerService.registerView(this));
		this.fileService = fileService;
		this.workspaceContextService = workspaceContextService;
		this.editorService = editorService;
		this.explorerService = explorerService;
		const renderer = this._register(new FilesRenderer(
			container.ownerDocument,
			workspaceContextService,
			resourceIconRenderer,
			hoverService,
			instantiationService,
			decorationsService,
			labelService,
		));
		this.element.classList.add("ash-explorer-view-pane");
		this.headerElement.classList.add("ash-explorer-title");
		this.contentElement.classList.add("ash-explorer");
		this.scrollContent = h(container.ownerDocument, 'div');
		this.scrollContent.className = 'ash-explorer-scroll-content';
		this.contentElement.append(this.scrollContent);
		this.tree = this._register(new WorkbenchAsyncDataTree<ExplorerItem, ExplorerItem>(this.scrollContent, new ExplorerDataSource(fileService, new FileSorter(), configurationService), {
			ariaLabel: localize('accessibility.explorerTreeLabel', 'Workspace files'),
			scrolling: "managed",
			configurationService,
			getHeight: () => 22,
			collapseByDefault: item => item.kind !== FileKind.File,
			expandOnlyOnTwistieClick: () => configurationService.getValue<TreeExpandMode>(ListConfiguration.treeExpandMode) === "doubleClick",
			identityProvider: { getId: (node) => node.resource.toString() },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: item => item.name },
			openOnSingleClick: true,
			reuseRows: true,
			onDidRemoveRow: row => renderer.disposeRow(row),
			renderElement: (item) => renderer.renderElement(item),
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
			this.tree.updateOptions({ twistieAdditionalCssClass: item => {
				// Nested file groups keep their arrow even when the theme hides directory arrows.
				if (item.kind !== FileKind.Directory && item.children?.length) {
					return 'ash-tree-twistie-with-icon-gap';
				}
				const hideTwistie = theme.hidesExplorerArrows || theme.hasFileIcons && !theme.hasFolderIcons && item.kind !== FileKind.Directory;
				return hideTwistie ? 'ash-tree-twistie-hidden' : 'ash-tree-twistie-with-icon-gap';
			} });
		};
		updateTwistieLayout();
		this._register(resourceIconRenderer.onDidChangeResourceIcons(updateTwistieLayout));
		this._register(new ExplorerFindProvider(this.tree, this.headerElement));
		this.scopedContext = this._register(contextKeyService.createScoped(this.element));
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
		this._register(this.tree.onDidChangeSelection(({ elements }) => this.updateExplorerContextKeys(elements[0])));
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
			if (event.affectsConfiguration(ExplorerFileNestingSettingId.Enabled) || event.affectsConfiguration(ExplorerFileNestingSettingId.Patterns)) {
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
			const roots = this.root?.children ?? (this.root ? [this.root] : []);
			for (const root of roots) {
				const changed = resources?.filter(resource => extUriBiasedIgnorePathCase.isEqualOrParent(resource, root.resource));
				if (changed && changed.length === 0) continue;
				if (!changed || changed.some(resource => extUriBiasedIgnorePathCase.isEqual(resource, root.resource))) {
					void this.refreshItem(root, true);
					continue;
				}
				const directories = new Map(
					[root, ...this.tree.getVisibleElements().filter(item => item.kind === FileKind.Directory)]
						.map(item => [extUriBiasedIgnorePathCase.getComparisonKey(item.resource), item] as const),
				);
				const targets = new Map<string, { item: ExplorerItem; recursive: boolean }>();
				for (const resource of changed) {
					const parent = dirname(resource);
					const directory = directories.get(extUriBiasedIgnorePathCase.getComparisonKey(parent));
					if (!directory) {
						void this.refreshItem(root, true);
						targets.clear();
						break;
					}
					targets.set(extUriBiasedIgnorePathCase.getComparisonKey(directory.resource), {
						item: directory,
						recursive: directories.has(extUriBiasedIgnorePathCase.getComparisonKey(resource)),
					});
				}
				for (const target of targets.values()) void this.refreshItem(target.item, target.recursive);
			}
		}));
		this.render();
		this.initialization = this.initialize();
	}

	public async selectResource(resource: URI | undefined, reveal: boolean | string = true): Promise<void> {
		this.setExpanded(true);
		await this.initialization;
		if (!resource) {
			this.tree.setSelection([]);
			return;
		}
		const generation = this.workspaceGeneration;
		const expanded = new Set<string>();
		// Only load ancestors of the requested file; nested file groups may contain sibling paths.
		while (!this.isDisposed && generation === this.workspaceGeneration) {
			const item = this.tree.getVisibleElements().find(candidate =>
				!expanded.has(extUriBiasedIgnorePathCase.getComparisonKey(candidate.resource)) && containsResource(candidate, resource));
			if (!item) return;
			if (extUriBiasedIgnorePathCase.isEqual(item.resource, resource)) {
				this.tree.setSelection([item]);
				if (reveal) this.tree.setFocus(item);
				return;
			}
			expanded.add(extUriBiasedIgnorePathCase.getComparisonKey(item.resource));
			await this.tree.updateChildren(item, { recursive: false });
			if (this.isDisposed || generation !== this.workspaceGeneration) return;
			this.tree.expand(item);
		}
	}

	public getContext(): readonly ExplorerItem[] {
		return this.tree.selection;
	}

	public collapseAll(): void {
		this.tree.collapseAll();
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

	private showExplorerContextMenu(event: MouseEvent | KeyboardEvent): void {
		event.preventDefault();
		event.stopPropagation();
		const row = event.target instanceof Element ? event.target.closest<HTMLElement>('.ash-tree-row') : null;
		const item = event instanceof MouseEvent
			? this.tree.getVisibleElements().find(candidate => candidate.resource.toString() === row?.dataset.treeId)
			: this.tree.focus;
		if (!item || !this.tree.selection.includes(item)) this.tree.setSelection(item ? [item] : []);
		this.updateExplorerContextKeys(item);
		const anchor = event instanceof MouseEvent
			? { x: event.clientX, y: event.clientY, targetWindow: this.element.ownerDocument.defaultView ?? undefined }
			: row ?? this.tree.element;
		this.contextMenuService.showContextMenu({
			menuId: MenuId.ExplorerContext,
			contextKeyService: this.scopedContext,
			menuActionOptions: { arg: item?.resource, shouldForwardArgs: true },
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
			await this.tree.setInput(this.root);
			if (this.isDisposed || generation !== this.workspaceGeneration) return;
			this.render();
		} catch (error) {
			if (this.isDisposed || generation !== this.workspaceGeneration) return;
			this.error = error instanceof Error
				? error.message
				: "Unable to load workspace files.";
			this.render();
		}
	}

	private async refreshRoot(root: ExplorerItem): Promise<void> {
		await this.refreshItem(root, true);
	}

	private async refreshItem(item: ExplorerItem, recursive: boolean): Promise<void> {
		const generation = this.workspaceGeneration;
		this.loadedNests.clear();
		try {
			await this.tree.updateChildren(item, { recursive });
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

function containsResource(item: ExplorerItem, resource: URI): boolean {
	return extUriBiasedIgnorePathCase.isEqual(item.resource, resource)
		|| item.kind === FileKind.Directory && extUriBiasedIgnorePathCase.isEqualOrParent(resource, item.resource)
		|| item.children?.some(child => containsResource(child, resource)) === true;
}
