import './media/chatInputCard.css';
import { h } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IChatWidgetModel } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { chatExecutionWorkspace } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';

/** Displays the saved conversation's effective execution directory. */
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
			if (directory.textContent === root) return;
			directory.hidden = !root;
			directory.textContent = directory.title = root;
		};
		this._register(model.onDidChange(update));
		this._register(sessions.onDidChange(update));
		update();
	}
}
