import { ScrollableElement } from "../../../../../base/browser/ui/scrollbar/scrollableElement.js";
import { URI } from "../../../../../base/common/uri.js";
import { IConfigurationService } from "../../../../../platform/configuration/common/configuration.js";
import { FileKind, IFileService } from "../../../../../platform/files/common/files.js";
import { IWorkspaceContextService } from "../../../../../platform/workspace/common/workspace.js";
import { IResourceIconRenderer } from "../../../../browser/labels.js";
import { IHoverService } from "../../../../../platform/hover/browser/hoverService.js";
import { IFileLabelDecorationService } from "../../../../services/labels/common/fileLabelDecorationService.js";
import { ILabelService } from "../../../../../platform/label/common/labelService.js";
import { WorkbenchAsyncDataTree, type ResourceOpenEvent } from "../../../../../platform/list/browser/listService.js";
import { IEditorService } from "../../../../services/editor/common/editorService.js";
import { ViewPane, type IViewPaneOptions } from "../../../../browser/parts/views/viewPane.js";
import { h } from "../../../../../base/browser/dom.js";
import { ExplorerItem } from "../../common/explorerModel.js";
import { ExplorerFileNestingSettingId } from '../../common/explorerFileNestingTrie.js';
import { ExplorerDataSource, ExplorerFindProvider, FileSorter, FilesRenderer } from "./explorerViewer.js";
import { extUriBiasedIgnorePathCase } from "../../../../../base/common/resources.js";
import { IExplorerService, type IExplorerView } from '../files.js';
import { ExplorerFocusedContext } from '../files.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { explorerFileContribRegistry } from '../explorerFileContrib.js';
import { AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { localize, onDidChangeNls } from '../../../../../nls.js';
import { WorkspaceWatcher } from '../workspaceWatcher.js';
import { FileEditorInput } from '../editors/fileEditorInput.js';

/** Workspace file tree backed by `IFileService` and the Workbench editor. */
export class ExplorerView extends ViewPane implements IExplorerView {
	private readonly fileService: IFileService;
	private readonly workspaceContextService: IWorkspaceContextService;
	private readonly editorService: IEditorService;
	private readonly scrollable: ScrollableElement;
	private readonly tree: WorkbenchAsyncDataTree<ExplorerItem, ExplorerItem>;
	private root: ExplorerItem | undefined;
	private error: string | undefined;
	private workspaceGeneration = 0;
	private readonly expandedDirectories = new Map<string, ExplorerItem>();
	private readonly loadedNests = new Set<string>();

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
		@IFileLabelDecorationService fileLabelDecorationService?: IFileLabelDecorationService,
		@ILabelService labelService?: ILabelService,
	) {
		super(container, options);
		this._register(explorerService.registerView(this));
		this.fileService = fileService;
		this.workspaceContextService = workspaceContextService;
		this.editorService = editorService;
		const renderer = this._register(new FilesRenderer(
			container.ownerDocument,
			workspaceContextService,
			resourceIconRenderer,
			hoverService,
			instantiationService,
			fileLabelDecorationService,
			labelService,
		));
		this.element.classList.add("ash-explorer-view-pane");
		this.headerElement.classList.add("ash-explorer-title");
		this.contentElement.classList.add("ash-explorer");
		this.scrollable = this._register(new ScrollableElement(this.contentElement, {
			ariaLabel: localize('accessibility.explorerTreeLabel', 'Workspace files'),
			direction: "vertical",
			vertical: "auto",
		}));
		this.tree = this._register(new WorkbenchAsyncDataTree<ExplorerItem, ExplorerItem>(this.scrollable.contentElement, new ExplorerDataSource(fileService, new FileSorter(), configurationService), {
			ariaLabel: localize('accessibility.explorerTreeLabel', 'Workspace files'),
			scrolling: "external",
			configurationService,
			indentGuides: "always",
			collapseByDefault: item => item.kind !== FileKind.File,
			expandOnlyOnTwistieClick: false,
			identityProvider: { getId: (node) => node.resource.toString() },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: item => item.name },
			openOnSingleClick: true,
			onWillRender: () => renderer.clear(),
			renderElement: (item) => renderer.renderElement(item),
		}));
		this._register(new ExplorerFindProvider(this.tree, this.headerElement));
		const scopedContext = this._register(contextKeyService.createScoped(this.element));
		ExplorerFocusedContext.bindTo(scopedContext).set(true);
		const updateAriaLabel = () => {
			const label = localize('accessibility.explorerTreeLabel', 'Workspace files');
			const hint = accessibleViewService.getOpenAriaHint(AccessibilityVerbositySettingId.Explorer);
			this.scrollable.element.setAttribute('aria-label', label);
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
		this._register(onDidChangeNls(updateAriaLabel));
		this._register(this.tree.onDidError(({ error }) => {
			this.error = error instanceof Error ? error.message : "Unable to read workspace files.";
			this.render();
		}));
		this._register(this.tree.onDidOpen((event) => {
			if (event.element.kind === FileKind.File) void this.openFile(event);
		}));
		this._register(this.tree.onDidChangeCollapseState(({ element, collapsed }) => {
			if (element.kind !== FileKind.Directory) {
				return;
			}
			if (collapsed) this.expandedDirectories.delete(element.resource.toString());
			else this.expandedDirectories.set(element.resource.toString(), element);
		}));
		this._register(this.tree.onDidChangeLoadState(({ loading }) => {
			if (!loading) {
				this.loadVisibleFileNests();
			}
		}));
		this._register(resourceIconRenderer.onDidChangeResourceIcons(
			() => this.render(),
		));
		this._register(explorerFileContribRegistry.onDidRegisterDescriptor(() => {
			const roots = this.root?.children ?? (this.root ? [this.root] : []);
			for (const root of roots) void this.refreshRoot(root);
		}));
		this._register(workspaceContextService.onDidChangeWorkspace(() => {
			void this.initialize();
		}));
		const watcher = this._register(new WorkspaceWatcher(fileService, workspaceContextService));
		this._register(watcher.onDidChange(resources => {
			const roots = this.root?.children ?? (this.root ? [this.root] : []);
			for (const root of roots) {
				if (resources && !resources.some(resource =>
					extUriBiasedIgnorePathCase.isEqualOrParent(resource, root.resource))) {
					continue;
				}
				void this.refreshRoot(root);
			}
		}));
		this.render();
		void this.initialize();
	}

	public getContext(): readonly ExplorerItem[] {
		return this.tree.selection;
	}

	public getAccessibleContent(): string {
		const heading = localize('accessibility.explorerVisibleFiles', 'Visible workspace files');
		const files = this.tree.getVisibleElements().map(item =>
			`${item.kind === FileKind.Directory ? localize('accessibility.explorerFolder', 'Folder') : localize('accessibility.explorerFile', 'File')}: ${item.name}`);
		return [heading, this.root?.name ?? '', ...files].filter(Boolean).join('\n');
	}

	public focus(): void {
		this.tree.domFocus();
	}

	private async initialize(): Promise<void> {
		const generation = ++this.workspaceGeneration;
		this.expandedDirectories.clear();
		this.loadedNests.clear();
		this.root = undefined;
		this.error = undefined;
		void this.tree.setInput(undefined);
		this.render();
		const workspace = this.workspaceContextService.getWorkspace();
		if (workspace.folders.length === 0) {
			this.error = "Open a folder to browse files.";
			this.render();
			return;
		}
		try {
			const roots = await Promise.all(workspace.folders.map(async folder => {
				const metadata = await this.fileService.stat(folder.uri);
				if (metadata.kind !== FileKind.Directory) throw new Error(`${folder.name} is not a directory`);
				return new ExplorerItem(folder.uri, folder.name, FileKind.Directory);
			}));
			if (this.isDisposed || generation !== this.workspaceGeneration) return;
			if (roots.length === 1) {
				this.setTitle(roots[0]!.name);
				this.root = roots[0];
			} else {
				this.setTitle(workspace.name ?? "Explorer");
				this.root = new ExplorerItem(
					URI.parse(`ash-workspace:/${encodeURIComponent(workspace.id)}`),
					workspace.name ?? "Workspace",
					FileKind.Directory,
					Object.freeze(roots),
				);
			}
			this.render();
			await this.tree.setInput(this.root);
		} catch (error) {
			if (this.isDisposed || generation !== this.workspaceGeneration) return;
			this.error = error instanceof Error
				? error.message
				: "Unable to load workspace files.";
			this.render();
		}
	}

	private async refreshRoot(root: ExplorerItem): Promise<void> {
		const generation = this.workspaceGeneration;
		this.loadedNests.clear();
		const expanded = [...this.expandedDirectories.values()]
			.filter(item => extUriBiasedIgnorePathCase.isEqualOrParent(item.resource, root.resource))
			.sort((left, right) => left.resource.path.length - right.resource.path.length);
		try {
			await this.tree.updateChildren(root);
			for (const item of expanded) {
				if (generation !== this.workspaceGeneration || this.isDisposed) return;
				await this.tree.updateChildren(item);
			}
		} catch (error) {
			if (generation !== this.workspaceGeneration || this.isDisposed) return;
			this.error = error instanceof Error ? error.message : "Unable to refresh workspace files.";
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
			await this.editorService.openEditor(new FileEditorInput(node.resource, { label: node.name }), event.editorOptions, event.sideBySide ? "sideGroup" : "activeGroup");
		} catch (error) {
			if (this.isDisposed) return;
			this.error = error instanceof Error
				? error.message
				: `Unable to open ${node.name}.`;
			this.render();
		}
	}

	private render(): void {
		const document = this.element.ownerDocument;
		const surface = h(document, "div");
		surface.className = "ash-explorer-scroll-content";
		if (!this.root) {
			const status = h(document, "div");
			status.className = "ash-explorer-status";
			status.setAttribute("role", "status");
			status.textContent = this.error ?? "Loading files…";
			surface.append(status);
			this.scrollable.replaceChildren(surface);
			return;
		}
		if (this.error) {
			const error = h(document, "div");
			error.className = "ash-explorer-status ash-explorer-error";
			error.setAttribute("role", "alert");
			error.textContent = this.error;
			surface.append(error);
		}
		surface.append(this.tree.element);
		this.scrollable.replaceChildren(surface);
	}

}
