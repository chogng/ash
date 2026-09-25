import { ScrollableElement } from "../../../../base/browser/ui/scrollbar/scrollableElement.js";
import { DisposableStore } from "../../../../base/common/lifecycle.js";
import { URI } from "../../../../base/common/uri.js";
import type { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { FileKind, type IFileEntry, type IFileService } from "../../../../platform/files/common/files.js";
import type { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import type { IResourceIconRenderer } from "../../../browser/labels.js";
import type { IHoverService } from "../../../../platform/hover/browser/hoverService.js";
import type { IFileLabelDecorationService } from "../../../services/labels/common/fileLabelDecorationService.js";
import type { ILabelService } from "../../../../platform/label/common/labelService.js";
import { DEFAULT_LABELS_CONTAINER, ResourceLabels } from "../../../browser/labels.js";
import { WorkbenchAsyncDataTree, type ResourceOpenEvent } from "../../../../platform/list/browser/listService.js";
import type { IEditorService } from "../../../services/editor/common/editorService.js";
import { ViewPane, type IViewPaneOptions } from "../../../browser/parts/views/viewPane.js";
import { h } from "../../../../base/browser/dom.js";

interface ExplorerNode {
	readonly resource: URI;
	readonly name: string;
	readonly kind: FileKind;
	readonly children?: readonly ExplorerNode[];
}

/** Workspace file tree backed by `IFileService` and the Workbench editor. */
export class ExplorerViewPane extends ViewPane {
	private readonly fileService: IFileService;
	private readonly workspaceContextService: IWorkspaceContextService;
	private readonly editorService: IEditorService;
	private readonly hoverService: IHoverService;
	private readonly resourceLabels: ResourceLabels;
	private readonly scrollable: ScrollableElement;
	private readonly tree: WorkbenchAsyncDataTree<ExplorerNode, ExplorerNode>;
	private readonly renderedLabels =
		this._register(new DisposableStore());
	private root: ExplorerNode | undefined;
	private error: string | undefined;
	private workspaceGeneration = 0;

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		fileService: IFileService,
		workspaceContextService: IWorkspaceContextService,
		editorService: IEditorService,
		resourceIconRenderer: IResourceIconRenderer,
		hoverService: IHoverService,
		configurationService: IConfigurationService,
		fileLabelDecorationService?: IFileLabelDecorationService,
		labelService?: ILabelService,
	) {
		super(container, options);
		this.fileService = fileService;
		this.workspaceContextService = workspaceContextService;
		this.editorService = editorService;
		this.hoverService = hoverService;
		this.resourceLabels = this._register(new ResourceLabels(DEFAULT_LABELS_CONTAINER, {
			workspaceContextService,
			resourceIconRenderer,
			fileLabelDecorationService,
			labelService,
		}));
		this.element.classList.add("ash-explorer-view-pane");
		this.headerElement.classList.add("ash-explorer-title");
		this.contentElement.classList.add("ash-explorer");
		this.scrollable = this._register(new ScrollableElement(this.contentElement, {
			ariaLabel: "Workspace files",
			direction: "vertical",
			vertical: "auto",
		}));
		this.tree = this._register(new WorkbenchAsyncDataTree<ExplorerNode, ExplorerNode>(this.scrollable.contentElement, {
			hasChildren: (node) => node.kind === FileKind.Directory,
			getChildren: async (node) => {
				if (node.children) return node.children;
				const entries = await this.fileService.readDirectory(node.resource);
				return entries.map(explorerNode).sort(compareExplorerNodes);
			},
		}, {
			ariaLabel: "Workspace files",
			scrolling: "external",
			configurationService,
			indentGuides: "always",
			expandOnlyOnTwistieClick: false,
			identityProvider: { getId: (node) => node.resource.toString() },
			openOnSingleClick: true,
			onWillRender: () => this.renderedLabels.clear(),
			renderElement: (node) => this.renderTreeElement(node),
		}));
		this._register(this.tree.onDidError(({ error }) => {
			this.error = error instanceof Error ? error.message : "Unable to read workspace files.";
			this.render();
		}));
		this._register(this.tree.onDidOpen((event) => {
			if (event.element.kind === FileKind.File) void this.openFile(event);
		}));
		this._register(resourceIconRenderer.onDidChangeResourceIcons(
			() => this.render(),
		));
		this._register(workspaceContextService.onDidChangeWorkspace(() => {
			void this.initialize();
		}));
		this.render();
		void this.initialize();
	}

	private async initialize(): Promise<void> {
		const generation = ++this.workspaceGeneration;
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
				return {
					resource: folder.uri,
					name: folder.name,
					kind: FileKind.Directory,
				} satisfies ExplorerNode;
			}));
			if (this.isDisposed || generation !== this.workspaceGeneration) return;
			if (roots.length === 1) {
				this.setTitle(roots[0]!.name);
				this.root = roots[0];
			} else {
				this.setTitle(workspace.name ?? "Explorer");
				this.root = {
					resource: URI.parse(`ash-workspace:/${encodeURIComponent(workspace.id)}`),
					name: workspace.name ?? "Workspace",
					kind: FileKind.Directory,
					children: Object.freeze(roots),
				};
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

	private async openFile(event: ResourceOpenEvent<ExplorerNode>): Promise<void> {
		const node = event.element;
		try {
			await this.editorService.openEditor({
				resource: node.resource,
				label: node.name,
			}, event.editorOptions, event.sideBySide ? "sideGroup" : "activeGroup");
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

	private renderTreeElement(node: ExplorerNode): HTMLElement {
		const document = this.element.ownerDocument;
		const content = h(document, "span");
		content.className = `ash-explorer-row-content ash-explorer-${node.kind}`;
		const label = this.renderedLabels.add(this.resourceLabels.create(content));
		label.setFile(node.resource, {
			fileKind: node.kind,
			fileDecorations: { colors: true, badges: true },
		});
		const labelText = label.element.querySelector<HTMLElement>(".ash-icon-label-text");
		this.renderedLabels.add(this.hoverService.setupHover({
			target: label.element,
			content: () => labelText && labelText.scrollWidth >
					labelText.clientWidth
				? node.name
				: undefined,
			groupId: "explorer.items",
		}));
		return content;
	}
}

function explorerNode(entry: IFileEntry): ExplorerNode {
	return {
		resource: entry.resource,
		name: entry.name,
		kind: entry.kind,
	};
}

function compareExplorerNodes(left: ExplorerNode, right: ExplorerNode): number {
	const leftDirectory = left.kind === FileKind.Directory;
	const rightDirectory = right.kind === FileKind.Directory;
	if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;
	return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}
