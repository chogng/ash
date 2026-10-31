import './media/filesView.css';
import { h } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { ViewPane, type IViewPaneOptions } from '../../../../workbench/browser/parts/views/viewPane.js';
import { ExplorerView } from '../../../../workbench/contrib/files/browser/views/explorerView.js';

// Explorer commands resolve this identity in each window's separate view catalog.
export const SESSIONS_FILES_VIEW_ID = 'ash.explorer';
export const SESSIONS_FILES_EMPTY_VIEW_ID = 'sessions.files.explorer.empty';

export class SessionsExplorerView extends ExplorerView {
	public override setVisible(visible: boolean): void {
		if (visible) {
			this.element.classList.add('ash-sessions-files-view');
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
		updateMessage();
	}
}
