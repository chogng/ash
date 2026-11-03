import './media/sessionsTitleBarWidget.css';
import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { autorun, observableFromEvent } from '../../../../base/common/observable.js';
import { environment } from '../../../../base/common/platform.js';
import { basename } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IChatSessionNavigationService } from '../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { SHOW_SESSIONS_PICKER_COMMAND_ID } from './sessionsActions.js';
import { ISessionsTitlebarService } from '../../../browser/parts/titlebarPart.js';
import { buildAgentHostSessionWorkspace } from '../../../common/agentHostSessionWorkspace.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import { sessionWorkspaceUri } from '../../../common/sessionWorkspace.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { BlockedSessionsIndicatorModel } from './blockedSessionsIndicatorModel.js';
import { BlockedSessionsCIFixModel } from './blockedSessionsCIFixModel.js';
import { showBlockedSessionsList } from './blockedSessionsList.js';

/** Presents the current workspace and opens the window's existing session picker. */
export class SessionsTitleBarWidget extends Disposable {
	static readonly ID = 'sessions.contrib.titleBarWidget';

	constructor(
		@ISessionsTitlebarService titlebar: ISessionsTitlebarService,
		@ISessionsService sessions: ISessionsService,
		@ICustomViewService customViews: ICustomViewService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
		@IContextKeyService contextKeys: IContextKeyService,
		@ICommandService commands: ICommandService,
		@IHoverService hovers: IHoverService,
		@ILayoutService layout: ILayoutService,
		@IInstantiationService instantiation: IInstantiationService,
		@IQuickInputService quickInput: IQuickInputService,
		@IChatSessionNavigationService navigation: IChatSessionNavigationService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		const indicator = instantiation.createInstance(BlockedSessionsIndicatorModel);
		const fixes = instantiation.createInstance(BlockedSessionsCIFixModel);
		const picker = this._register(new MutableDisposable());
		const element = h(layout.mainContainer.ownerDocument, 'div', { className: 'ash-sessions-titlebar-widget' });
		const button = this._register(new Button(element, {
			...defaultButtonStyles,
			presentation: 'quiet',
			size: 'small',
			label: '',
			onClick: () => {
				if (indicator.blockedSessions.get().length) {
					picker.value = showBlockedSessionsList(quickInput, navigation, indicator, fixes, notifications, button.domNode);
				} else {
					void commands.executeCommand(SHOW_SESSIONS_PICKER_COMMAND_ID).catch(onUnexpectedError);
				}
			},
		}));
		button.domNode.classList.add('ash-titlebar-interactive-region');
		const hover = this._register(hovers.setupHover({ target: button.domNode, content: undefined }));
		const folders = observableFromEvent(this, workspace.onDidChangeWorkspaceFolders, () => workspace.getWorkspace().folders);
		const modeKey = SessionsWorkspaceModeContext.key;
		const modeKeys = new Set([modeKey]);
		const mode = observableFromEvent(this, listener => contextKeys.onDidChangeContext(event => {
			if (event.affectsSome(modeKeys)) listener(event);
		}), () => contextKeys.getValue(modeKey));
		this._register(autorun(reader => {
			const selection = sessions.getSelection(reader).activeSelection;
			element.hidden = !!customViews.activeCustomView.read(reader) || (environment.runtime === 'electron' && mode.read(reader) !== 'code');
			if (element.hidden) {
				picker.clear();
				hover.hide();
				return;
			}
			const count = indicator.blockedSessions.read(reader).length;
			if (count) {
				const attention = count === 1
					? localize('sessions.blocked.one', '1 session requires attention')
					: localize('sessions.blocked.many', '{0} sessions require attention', count);
				button.icon = Lxicon.warning;
				button.label = attention;
				button.domNode.setAttribute('aria-label', attention);
				hover.update(attention);
				return;
			}
			let label: string | undefined;
			let path: string | undefined;
			let branch: string | undefined;
			if (selection?.kind === 'session') {
				const { session, threadId } = selection.active;
				const chatWorkspace = session.chats.find(chat => chat.threadId === threadId)?.workspace;
				const location = chatWorkspace === undefined ? session.workspace : chatWorkspace;
				if (location) {
					path = location.root;
					label = basename(sessionWorkspaceUri(location)) || path;
				}
			} else if (selection?.kind === 'untitled') {
				const target = selection.session.workspace;
				branch = selection.session.branchName;
				if (target.type === 'current') {
					const current = folders.read(reader);
					label = current.map(folder => folder.name).join(', ');
					path = current.map(folder => folder.uri.scheme === 'file' ? folder.uri.fsPath : folder.uri.toString()).join(' · ');
				} else if (target.type === 'multiple') {
					label = target.folders.map(folder => folder.label).join(', ');
					path = target.folders.map(folder => folder.target.root).join(' · ');
				} else {
					const location = buildAgentHostSessionWorkspace(target)!;
					path = location.root;
					label = basename(sessionWorkspaceUri(location)) || path;
				}
			}
			const workspaceLabel = label || localize('sessions.titlebar.noWorkspace', 'No workspace');
			const contextLabel = branch ? localize('sessions.titlebar.branch', '{0} · {1}', workspaceLabel, branch) : workspaceLabel;
			button.icon = label ? Lxicon.folder : Lxicon.chat;
			button.label = contextLabel;
			button.domNode.setAttribute('aria-label', localize('sessions.titlebar.showHistory', 'Show Session History ({0})', contextLabel));
			hover.update(path && branch ? localize('sessions.titlebar.branch', '{0} · {1}', path, branch) : path || contextLabel);
		}));
		this._register(titlebar.setSessionContent(element));
	}
}
