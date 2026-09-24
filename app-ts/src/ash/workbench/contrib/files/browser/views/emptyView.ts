import { Button } from "../../../../../base/browser/ui/button/button.js";
import {
	ViewPane,
	type IViewPaneOptions,
} from "../../../../browser/parts/views/viewPane.js";
import type {
	IWorkspaceOpenService,
} from "../../../../services/workspaces/browser/workspaceOpenService.js";
import { h } from "../../../../../base/browser/dom.js";

/**
 * Files pane shown when the current Workbench has no workspace folders.
 *
 * Folder selection remains a host capability; this view delegates through
 * `IWorkspaceOpenService` and never accesses the native filesystem directly.
 */
export class EmptyView extends ViewPane {
	static readonly ID = "ash.emptyExplorer";
	static readonly TITLE = "No Folder Opened";

	private readonly openButton: Button;
	private readonly statusElement: HTMLParagraphElement;
	private readonly workspaceOpenService: IWorkspaceOpenService;

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		workspaceOpenService: IWorkspaceOpenService,
	) {
		super(container, options);
		this.workspaceOpenService = workspaceOpenService;
		this.contentElement.classList.add("ash-empty-explorer");

		const message = h(container.ownerDocument, "p");
		message.className = "ash-empty-explorer-message";
		message.textContent = "Open a folder to explore its files.";
		this.openButton = this._register(new Button(this.contentElement, {
			label: "Open Folder",
			enabled: workspaceOpenService.canOpenFolder,
			title: workspaceOpenService.canOpenFolder
				? "Open Folder"
				: "Opening folders is unavailable in this host",
			onClick: () => {
				void this.openFolder();
			},
		}));
		this.openButton.toggleClassName("ash-empty-explorer-open-folder", true);
		this.statusElement = h(container.ownerDocument, "p");
		this.statusElement.className = "ash-empty-explorer-status";
		this.statusElement.setAttribute("role", "status");
		this.statusElement.setAttribute("aria-live", "polite");
		this.contentElement.append(
			message,
			this.openButton.domNode,
			this.statusElement,
		);
	}

	private async openFolder(): Promise<void> {
		if (!this.workspaceOpenService.canOpenFolder) return;
		this.openButton.enabled = false;
		this.statusElement.textContent = "";
		try {
			await this.workspaceOpenService.openFolder();
		} catch (error) {
			if (this.isDisposed) return;
			this.statusElement.textContent = error instanceof Error
				? error.message
				: "Unable to open a folder.";
		} finally {
			if (!this.isDisposed) {
				this.openButton.enabled =
					this.workspaceOpenService.canOpenFolder;
			}
		}
	}
}
