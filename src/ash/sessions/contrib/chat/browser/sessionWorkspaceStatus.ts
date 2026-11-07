import './media/chatInputCard.css';
import { h } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import type { IChatWidgetModel } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { chatExecutionWorkspace } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';

/** Shows the workspace in the footer, with the effective execution directory on hover. */
export class SessionWorkspaceStatus extends Disposable {
	constructor(
		footer: HTMLElement,
		model: IChatWidgetModel,
		@ISessionsManagementService sessions: ISessionsManagementService,
	) {
		super();
		const directory = h(footer.ownerDocument, 'span', {
			className: 'ash-session-workspace-status',
			properties: { hidden: true },
		});
		footer.prepend(directory);
		this._register(toDisposable(() => directory.remove()));
		const update = () => {
			const session = model.threadId && sessions.sessions.find(candidate => candidate.sessionId === model.sessionId);
			const workspace = session ? chatExecutionWorkspace(session, session.chats.find(chat => chat.threadId === model.threadId)) : undefined;
			const root = workspace?.root ?? '';
			const source = session ? session.workspace : undefined;
			let label = root;
			if (workspace?.authorityId === 'local' && source?.authorityId === 'local' && source.root !== root) {
				// The Session keeps the selected folder while the Thread runs in its managed checkout.
				label = basename(URI.file(source.root)) || source.root;
			}
			if (directory.textContent === label && directory.title === root) { return; }
			directory.hidden = !root;
			directory.textContent = label;
			directory.title = root;
		};
		this._register(model.onDidChange(update));
		this._register(sessions.onDidChange(update));
		update();
	}
}
