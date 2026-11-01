import './media/filesView.css';
import { ExplorerView } from '../../../../workbench/contrib/files/browser/views/explorerView.js';

// Explorer commands resolve this identity in each window's separate view catalog.
export const SESSIONS_FILES_VIEW_ID = 'ash.explorer';

export class SessionsExplorerView extends ExplorerView {
	public override setVisible(visible: boolean): void {
		if (visible) {
			this.element.classList.add('ash-sessions-files-view');
		}
		super.setVisible(visible);
	}
}
