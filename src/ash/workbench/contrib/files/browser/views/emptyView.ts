import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { Button } from "../../../../../base/browser/ui/button/button.js";
import {
	ViewPane,
	type IViewPaneOptions,
} from "../../../../browser/parts/views/viewPane.js";
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { OpenFolderWorkspaceSupportContext, BrowserLocalFolderSupportContext } from '../../../../common/contextkeys.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { h } from "../../../../../base/browser/dom.js";

/**
 * Files pane shown when the current Workbench has no workspace folders.
 *
 * Folder selection remains a host capability; this view delegates through
 * `IFileDialogService` and never accesses the native filesystem directly.
 */
export class EmptyView extends ViewPane {
	static readonly ID = "ash.emptyExplorer";
	static readonly TITLE = "No Folder Opened";

	private readonly openButton: Button;
	private readonly statusElement: HTMLParagraphElement;

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		@IFileDialogService private readonly fileDialogs: IFileDialogService,
		@IContextKeyService private readonly contexts: IContextKeyService,
	) {
		super(container, options);
		this.contentElement.classList.add("ash-empty-explorer");

		const message = h(container.ownerDocument, "p");
		message.className = "ash-empty-explorer-message";
		message.textContent = "Open a folder to explore its files.";
		this.openButton = this._register(new Button(this.contentElement, {
			...defaultButtonStyles,
			label: "Open Folder",
			enabled: this.canOpenFolder,
			title: this.canOpenFolder
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

	private get canOpenFolder(): boolean {
		return this.contexts.contextMatchesRules(ContextKeyExpr.or(OpenFolderWorkspaceSupportContext.isEqualTo(true), BrowserLocalFolderSupportContext.isEqualTo(true)));
	}

	private async openFolder(): Promise<void> {
		if (!this.canOpenFolder) return;
		this.openButton.enabled = false;
		this.statusElement.textContent = "";
		try {
			await this.fileDialogs.pickFolderAndOpen();
		} catch (error) {
			if (this.isDisposed) return;
			this.statusElement.textContent = error instanceof Error
				? error.message
				: "Unable to open a folder.";
		} finally {
			if (!this.isDisposed) {
				this.openButton.enabled =
					this.canOpenFolder;
			}
		}
	}
}
