import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { IChatWidgetModel } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { canOpenThreadInCode } from '../../../services/sessions/common/session.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';

export const sessionWorkspaceButtonHelp = () => localize({ bundle: 'ash.sessions', key: 'sessions.workspace.toggleHelp' }, 'In a saved local conversation, use Tab to reach Use workspace. Press Enter or Space to choose a folder or to turn the workspace off for subsequent messages. Wait for any running work or pending approvals to finish before changing the folder.');
export const continueInCodeHelp = () => localize({ bundle: 'ash.sessions', key: 'sessions.workspace.continueInCodeHelp' }, 'After binding a workspace, use Tab to reach Continue in Code. Press Enter or Space to open this conversation and its history in Code.');

/** Changes the directory of the conversation owned by this composer. */
export class SessionWorkspaceButton extends Disposable {
	constructor(
		footer: HTMLElement,
		model: IChatWidgetModel,
		showContinueInCode: boolean,
		@ISessionsManagementService sessions: ISessionsManagementService,
		@IFileDialogService dialogs: IFileDialogService,
		@INotificationService notifications: INotificationService,
		@ISessionsService view: ISessionsService,
	) {
		super();
		const label = localize({ bundle: 'ash.sessions', key: 'sessions.workspace.use' }, 'Use workspace');
		const indicator = h(footer.ownerDocument, 'span', { attributes: { 'aria-hidden': 'true' } });
		const button = h(footer.ownerDocument, 'button', {
			className: 'ash-button ash-button-quiet ash-button-small',
			properties: { type: 'button' },
		});
		button.append(indicator, label);
		footer.prepend(button);
		const continueButton = showContinueInCode ? h(footer.ownerDocument, 'button', {
			className: 'ash-button ash-button-quiet ash-button-small',
			properties: { type: 'button' },
		}) : undefined;
		if (continueButton) {
			continueButton.textContent = localize({ bundle: 'ash.sessions', key: 'sessions.workspace.continueInCode' }, 'Continue in Code');
			button.after(continueButton);
			this._register(addDisposableListener(continueButton, 'click', () => {
				const session = sessions.sessions.find(candidate => candidate.sessionId === model.sessionId);
				const thread = session?.chats.find(candidate => candidate.threadId === model.threadId);
				if (operation || session?.kind !== 'chat' || session.status !== 'active' || !thread || !canOpenThreadInCode(session, thread)) return;
				void view.openSession(session.sessionId, thread.threadId, { reveal: 'code' }).catch(error => {
					if (!isCancellationError(error)) notifications.error(toErrorMessage(error));
				});
			}));
		}
		let operation: AbortController | undefined;
		let sessionId: string | undefined;
		const update = () => {
			if (sessionId !== model.sessionId) {
				sessionId = model.sessionId;
				operation?.abort();
				operation = undefined;
			}
			const session = sessions.sessions.find(candidate => candidate.sessionId === sessionId);
			if (continueButton) {
				const thread = session?.chats.find(candidate => candidate.threadId === model.threadId);
				const available = session?.kind === 'chat' && session.status === 'active' && !!thread && canOpenThreadInCode(session, thread);
				continueButton.hidden = !available;
				continueButton.classList.toggle('hidden', !available);
				continueButton.disabled = !!operation;
			}
			const supported = !!session && sessions.canClearDirectory?.(session.sessionId) === true;
			button.hidden = !supported;
			button.classList.toggle('hidden', !supported);
			button.setAttribute('aria-disabled', String(!supported || !!operation || !sessions.canChangeDirectory?.(session.sessionId)));
			const pressed = String(!!session?.workspace);
			if (button.getAttribute('aria-pressed') !== pressed) {
				button.setAttribute('aria-pressed', pressed);
				indicator.replaceChildren();
				appendIcon(session?.workspace ? Lxicon.check : Lxicon.folder, indicator);
			}
			button.title = session?.workspace?.root ?? label;
		};
		this._register(toDisposable(() => {
			operation?.abort();
			button.remove();
			continueButton?.remove();
		}));
		this._register(model.onDidChange(update));
		this._register(sessions.onDidChange(update));
		this._register(addDisposableListener(button, 'click', async () => {
			const id = sessionId;
			const session = sessions.sessions.find(candidate => candidate.sessionId === id);
			if (button.getAttribute('aria-disabled') === 'true' || !session || !sessions.changeDirectory) return;
			const request = operation = new AbortController();
			update();
			try {
				let root: string | null = null;
				if (!session.workspace) {
					const [folder] = await dialogs.showOpenDialog({
						title: label, availableFileSystems: ['file'],
						canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
					}) ?? [];
					if (folder?.scheme !== 'file' || folder.authority) return;
					root = folder.fsPath;
				}
				if (request.signal.aborted || !button.isConnected || button.getClientRects().length === 0) return;
				await sessions.changeDirectory(session.sessionId, root, request.signal);
				if (request.signal.aborted) return;
				status(root === null
					? localize({ bundle: 'ash.sessions', key: 'sessions.workspace.disabled' }, 'Workspace off.')
					: localize({ bundle: 'ash.sessions', key: 'sessions.workspace.enabled' }, 'Workspace set to {0}.', root));
			} catch (error) {
				if (!request.signal.aborted && !isCancellationError(error)) notifications.error(toErrorMessage(error));
			} finally {
				if (operation === request) operation = undefined;
				update();
			}
		}));
		update();
	}
}
