import './media/filesView.css';
import { h } from '../../../../base/browser/dom.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize, onDidChangeNls } from '../../../../nls.js';
import { ViewPane, type IViewPaneOptions, type PartTitleProjection } from '../../../../workbench/browser/parts/views/viewPane.js';
import { ExplorerView } from '../../../../workbench/contrib/files/browser/views/explorerView.js';

// Explorer commands resolve this identity in each window's separate view catalog.
export const SESSIONS_FILES_VIEW_ID = 'ash.explorer';
export const SESSIONS_FILES_EMPTY_VIEW_ID = 'sessions.files.explorer.empty';

export class SessionsExplorerView extends ExplorerView {
	private actions: WorkbenchToolBar | undefined;

	public override get partTitleProjection(): PartTitleProjection {
		// Sessions hides pane headers, so the container title owns the Files actions.
		return { actions: this.headerActionsElement };
	}

	public override setVisible(visible: boolean): void {
		if (visible && !this.actions) {
			this.element.classList.add('ash-sessions-files-view');
			const actions = this._register(new WorkbenchToolBar(this.headerActionsElement, this.contextMenuService));
			this.actions = actions;
			const updateActions = (): void => {
				const label = localize('sessions.files.collapseFolders', 'Collapse folders');
				actions.element.setAttribute('aria-label', localize('sessions.files.actions', 'Files actions'));
				actions.setActions([{
					id: 'sessions.files.action.collapseExplorerFolders',
					label,
					tooltip: label,
					icon: Lxicon.chevronUp,
					enabled: true,
					run: () => this.commandService.executeCommand('sessions.files.action.collapseExplorerFolders'),
				}]);
			};
			this._register(onDidChangeNls(updateActions));
			updateActions();
		}
		super.setVisible(visible);
	}
}

export class SessionsExplorerEmptyView extends ViewPane {
	constructor(container: HTMLElement, options: IViewPaneOptions) {
		super(container, options);
		this.element.classList.add('ash-sessions-files-empty-view');
		this.contentElement.classList.add('ash-sessions-files-empty-content');
		const message = h(container.ownerDocument, 'p');
		message.className = 'ash-sessions-files-empty-message';
		message.setAttribute('role', 'status');
		this.contentElement.append(message);
		const updateMessage = (): void => {
			message.textContent = localize('sessions.files.noFiles', 'Folders and files will appear here.');
		};
		this._register(onDidChangeNls(updateMessage));
		updateMessage();
	}
}
