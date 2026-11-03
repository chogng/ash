import './media/sessionsTitleBarWidget.css';
import { addDisposableListener, getActiveElement, h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { autorun, observableFromEvent } from '../../../../base/common/observable.js';
import { environment } from '../../../../base/common/platform.js';
import { basename } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IAgentSessionActionsService, type IAgentSessionActionTarget } from '../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsService.js';
import { IChatSessionNavigationService } from '../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { SHOW_SESSIONS_PICKER_COMMAND_ID } from './sessionsActions.js';
import { createSessionItemActions } from '../../../browser/agentSessionsModel.js';
import { ISessionsTitlebarService } from '../../../browser/parts/titlebarPart.js';
import { buildAgentHostSessionWorkspace } from '../../../common/agentHostSessionWorkspace.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import { sessionWorkspaceUri } from '../../../common/sessionWorkspace.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { ISessionsListModelService } from '../../../services/sessions/browser/sessionsListModelService.js';
import { ISessionsService, type SessionsViewSelection } from '../../../services/sessions/browser/sessionsService.js';
import { BlockedSessionsIndicatorModel } from './blockedSessionsIndicatorModel.js';
import { BlockedSessionsCIFixModel } from './blockedSessionsCIFixModel.js';
import { showBlockedSessionsList } from './blockedSessionsList.js';

function renameTarget(selection: SessionsViewSelection | undefined): string | { untitledSessionId: string; } | undefined {
	if (selection?.kind === 'session') return selection.active.session.sessionId;
	if (selection) return { untitledSessionId: selection.session.untitledSessionId };
	return undefined;
}

/** Presents the active session title and its workspace context. */
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
		@IAgentSessionActionsService sessionActions: IAgentSessionActionsService,
		@IContextMenuService contextMenus: IContextMenuService,
		@ISessionsListModelService listModel: ISessionsListModelService,
	) {
		super();
		const indicator = instantiation.createInstance(BlockedSessionsIndicatorModel);
		const fixes = instantiation.createInstance(BlockedSessionsCIFixModel);
		const picker = this._register(new MutableDisposable());
		const element = h(layout.mainContainer.ownerDocument, 'div', { className: 'ash-sessions-titlebar-widget' });
		const titleContainer = h(element.ownerDocument, 'div', { className: 'ash-sessions-titlebar-title' });
		element.append(titleContainer);
		let edit: { key: string; target: IAgentSessionActionTarget; saving: boolean; restoreFocus: boolean; } | undefined;
		const input = h(element.ownerDocument, 'input', {
			className: 'ash-sessions-titlebar-rename ash-titlebar-interactive-region',
			properties: { type: 'text', hidden: true },
			attributes: { 'aria-label': localize('sessions.titlebar.sessionName', 'Session name') },
		});
		const button = this._register(new Button(titleContainer, {
			...defaultButtonStyles,
			presentation: 'quiet',
			size: 'small',
			label: '',
			onClick: event => {
				if (indicator.blockedSessions.get().length) {
					picker.value = showBlockedSessionsList(quickInput, navigation, indicator, fixes, notifications, button.domNode);
					return;
				}
				const target = renameTarget(sessions.activeSelection);
				if (target === undefined) {
					void commands.executeCommand(SHOW_SESSIONS_PICKER_COMMAND_ID).catch(onUnexpectedError);
					return;
				}
				beginEdit(target, event.detail === 0);
			},
		}));
		button.domNode.classList.add('ash-titlebar-interactive-region');
		const hover = this._register(hovers.setupHover({ target: button.domNode, content: undefined }));
		titleContainer.append(input);
		const beginEdit = (target: NonNullable<ReturnType<typeof renameTarget>>, restoreFocus: boolean) => {
			try {
				const captured = sessionActions.resolveTarget(target);
				edit = { key: JSON.stringify(target), target: captured, saving: false, restoreFocus };
				input.value = captured.title;
				input.readOnly = false;
				input.hidden = false;
				hover.hide();
				input.focus();
				input.select();
				button.hidden = true;
			} catch (error) {
				notifications.error(toErrorMessage(error));
			}
		};
		const menuButton = this._register(new Button(element, {
			...defaultButtonStyles,
			presentation: 'quiet',
			size: 'small',
			icon: Lxicon.chevronDown,
			iconOnly: true,
			label: localize('sessions.list.moreActions', 'More Sessions Actions'),
			onClick: event => {
				const selection = sessions.activeSelection;
				const target = renameTarget(selection);
				if (!selection || target === undefined) return;
				const targetKey = JSON.stringify(target);
				const actions = createSessionItemActions(selection, commands, listModel, notifications,
					() => commands.executeCommand('sessions.openInNewWindow', selection));
				menuButton.domNode.setAttribute('aria-expanded', 'true');
				contextMenus.showContextMenu({
					getAnchor: () => menuButton.domNode,
					getActions: () => actions.map(action => action.id === 'agentSession.rename'
						? {
							...action, run: () => {
								if (JSON.stringify(renameTarget(sessions.activeSelection)) === targetKey) {
									beginEdit(target, event.detail === 0);
								}
							}
						}
						: action),
					autoSelectFirstItem: true,
					onHide: () => menuButton.domNode.setAttribute('aria-expanded', 'false'),
				});
			},
		}));
		menuButton.domNode.classList.add('ash-titlebar-interactive-region', 'ash-sessions-titlebar-menu');
		menuButton.domNode.setAttribute('aria-haspopup', 'menu');
		menuButton.domNode.setAttribute('aria-expanded', 'false');
		const finishEdit = (restoreFocus: boolean) => {
			const shouldRestoreFocus = restoreFocus && edit?.restoreFocus;
			edit = undefined;
			button.hidden = false;
			if (shouldRestoreFocus) button.focus();
			input.hidden = true;
			input.setCustomValidity('');
		};
		const saveEdit = async () => {
			const draft = edit;
			if (!draft || draft.saving) return;
			const title = input.value.trim();
			if (!title || Array.from(title).length > 256) {
				input.setCustomValidity(localize('sessions.titlebar.invalidName', 'Enter a name with 1 to 256 characters.'));
				input.reportValidity();
				return;
			}
			if (title === draft.target.title) {
				finishEdit(true);
				return;
			}
			draft.saving = true;
			input.readOnly = true;
			try {
				const target = await draft.target.resolve();
				await sessionActions.renameSession(target.sessionId, title);
				if (edit === draft) finishEdit(getActiveElement(element.ownerDocument) === input);
			} catch (error) {
				if (edit === draft) {
					draft.saving = false;
					input.readOnly = false;
				}
				notifications.error(toErrorMessage(error));
			}
		};
		this._register(addDisposableListener(input, 'input', () => input.setCustomValidity('')));
		this._register(addDisposableListener(input, 'keydown', event => {
			if (event.isComposing || (event.key !== 'Enter' && event.key !== 'Escape')) return;
			event.preventDefault();
			event.stopPropagation();
			if (edit?.saving) return;
			if (event.key === 'Escape') finishEdit(true);
			else void saveEdit();
		}));
		this._register(addDisposableListener(input, 'blur', () => {
			if (edit && !edit.saving) finishEdit(false);
		}));
		const folders = observableFromEvent(this, workspace.onDidChangeWorkspaceFolders, () => workspace.getWorkspace().folders);
		const modeKey = SessionsWorkspaceModeContext.key;
		const modeKeys = new Set([modeKey]);
		const mode = observableFromEvent(this, listener => contextKeys.onDidChangeContext(event => {
			if (event.affectsSome(modeKeys)) listener(event);
		}), () => contextKeys.getValue(modeKey));
		this._register(autorun(reader => {
			const selection = sessions.getSelection(reader).activeSelection;
			element.hidden = !!customViews.activeCustomView.read(reader) || (environment.runtime === 'electron' && mode.read(reader) !== 'code');
			const count = indicator.blockedSessions.read(reader).length;
			menuButton.hidden = !selection || count > 0;
			button.domNode.classList.toggle('ash-sessions-titlebar-editable', !menuButton.hidden);
			if (edit && (element.hidden || count || edit.key !== JSON.stringify(renameTarget(selection)))) {
				finishEdit(!element.hidden && edit.saving && getActiveElement(element.ownerDocument) === input);
			}
			if (element.hidden) {
				picker.clear();
				hover.hide();
				return;
			}
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
			button.icon = undefined;
			const title = selection?.kind === 'session' ? selection.active.session.title : selection?.session.title;
			button.label = title ?? contextLabel;
			button.domNode.setAttribute('aria-label', title === undefined
				? localize('sessions.titlebar.showHistory', 'Show Session History ({0})', contextLabel)
				: localize('sessions.titlebar.renameSession', 'Rename session ({0})', title));
			const workspaceDetails = path && branch ? localize('sessions.titlebar.branch', '{0} · {1}', path, branch) : path || contextLabel;
			hover.update(() => {
				const titleLabel = button.domNode.querySelector('.ash-button-label');
				return titleLabel && titleLabel.scrollWidth > titleLabel.clientWidth
					? button.label
					: workspaceDetails;
			});
		}));
		this._register(titlebar.setSessionContent(element));
	}
}
