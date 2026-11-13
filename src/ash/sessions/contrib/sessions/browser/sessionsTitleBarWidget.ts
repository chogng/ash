import './media/sessionsTitleBarWidget.css';
import { getActiveElement, h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { ContextViewHideReason } from '../../../../base/browser/ui/contextview/contextview.js';
import { Action, Separator, type IAction } from '../../../../base/common/actions.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { autorun, derived, observableFromEvent, observableValue } from '../../../../base/common/observable.js';
import { environment } from '../../../../base/common/platform.js';
import { basename } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { getChatSessionArchiveActionPresentation, getChatSessionArchiveActionWording } from '../../../../platform/chat/common/sessionArchiveActions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IAgentSessionActionsService } from '../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsService.js';
import { IChatSessionNavigationService } from '../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { SHOW_SESSIONS_PICKER_COMMAND_ID } from './sessionsActions.js';
import { createSessionItemActions, createSessionWorkspaceActions } from '../../../browser/agentSessionsModel.js';
import { renderInlineRenameInput, showInlineRenameInput } from '../../../browser/parts/titlebar/inlineRenameInput.js';
import { TitleMenuActionViewItem } from '../../../browser/parts/titlebar/titleMenuActionViewItem.js';
import { getSessionsTitlebarPart } from '../../../browser/parts/titlebarPart.js';
import { ITitleService } from '../../../../workbench/services/title/browser/titleService.js';
import { buildAgentHostSessionWorkspace } from '../../../common/agentHostSessionWorkspace.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import { sessionWorkspaceUri } from '../../../common/sessionWorkspace.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { ISessionsListModelService } from '../../../services/sessions/browser/sessionsListModelService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISessionsService, type SessionsViewSelection } from '../../../services/sessions/browser/sessionsService.js';
import { IChatListCatalog, type ChatListEntry } from '../../chat/browser/chatListModel.js';
import { ISessionsConversationService } from '../../../services/sessions/common/sessionsConversation.js';
import { IBlockedSessionsIndicatorService } from './blockedSessionsIndicatorModel.js';
import { BlockedSessionsCIFixModel } from './blockedSessionsCIFixModel.js';
import { showBlockedSessionsList } from './blockedSessionsList.js';

function renameTarget(selection: SessionsViewSelection | undefined): string | { untitledSessionId: string; } | undefined {
	if (selection?.kind === 'session') return selection.active.session.sessionId;
	if (selection) return { untitledSessionId: selection.session.untitledSessionId };
	return undefined;
}

function chatTitleKey(entry: ChatListEntry): string {
	return JSON.stringify([entry.id, entry.preferenceKey]);
}

interface TitleRename {
	readonly key: string;
	readonly title: string;
	rename(title: string): Promise<void>;
}

/** Presents the active conversation and its available title actions. */
export class SessionsTitleBarWidget extends Disposable {
	static readonly ID = 'sessions.contrib.titleBarWidget';

	constructor(
		@ITitleService titleService: ITitleService,
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
		@IBlockedSessionsIndicatorService indicator: IBlockedSessionsIndicatorService,
		@ISessionsManagementService management: ISessionsManagementService,
		@IChatListCatalog catalog: IChatListCatalog,
		@ISessionsConversationService conversation: ISessionsConversationService,
		@IConfigurationService configuration: IConfigurationService,
	) {
		super();
		const fixes = instantiation.createInstance(BlockedSessionsCIFixModel);
		const picker = this._register(new MutableDisposable());
		const element = h(layout.mainContainer.ownerDocument, 'div', { className: 'ash-sessions-titlebar-widget' });
		const titleContainer = h(element.ownerDocument, 'div', { className: 'ash-sessions-titlebar-title' });
		element.append(titleContainer);
		const modeKey = SessionsWorkspaceModeContext.key;
		const modeKeys = new Set([modeKey]);
		const mode = observableFromEvent<'chat' | 'code'>(this, listener => contextKeys.onDidChangeContext(event => {
			if (event.affectsSome(modeKeys)) listener(event);
		}), () => contextKeys.getValue(modeKey) === 'code' ? 'code' : 'chat');
		const desktopChat = mode.map(value => environment.runtime === 'electron' && value === 'chat');
		const activeChat = derived(reader => {
			if (!desktopChat.read(reader) || !conversation.hasDesktopChatSource.read(reader)) return undefined;
			for (const source of catalog.sources) {
				const entry = source.snapshot.read(reader).entries.find(row => row.selected);
				if (entry) return entry;
			}
			return undefined;
		});
		const activeKey = () => {
			const entry = activeChat.get();
			if (entry) return chatTitleKey(entry);
			const target = renameTarget(sessions.activeSelection);
			return desktopChat.get() || target === undefined ? undefined : JSON.stringify([mode.get(), target]);
		};
		const canAct = (entry: ChatListEntry) => !entry.disabled && !entry.actionsDisabled;
		const button = this._register(new Button(titleContainer, {
			...defaultButtonStyles,
			presentation: 'quiet',
			size: 'small',
			label: '',
			onClick: event => {
				if (indicator.blockedSessions.get().length) {
					picker.value = showBlockedSessionsList(quickInput, navigation, indicator, mode.get() === 'code' ? fixes : undefined, notifications, button.domNode);
					return;
				}
				const target = renameTarget(sessions.activeSelection);
				if (target === undefined) {
					void commands.executeCommand(SHOW_SESSIONS_PICKER_COMMAND_ID).catch(onUnexpectedError);
					return;
				}
				beginSessionEdit(target, event.detail === 0);
			},
		}));
		button.domNode.classList.add('ash-titlebar-interactive-region');
		const titleMenuHost = h(element.ownerDocument, 'div');
		titleContainer.append(titleMenuHost);
		const titleAction = this._register(new Action('sessions.titlebar.chatActions'));
		const titleMenu = this._register(new TitleMenuActionViewItem(titleAction, () => {
			return desktopChat.get() ? getDesktopChatActions() : getSessionActions('chat', true);
		}, contextMenus, () => getRenameAction()));
		titleMenu.render(titleMenuHost);
		const menuOpen = observableValue('sessionTitleMenuOpen', false);
		this._register(titleMenu.onDidChangeVisibility(visible => menuOpen.set(visible, undefined)));
		let combinedMenu = false;
		const titleHovers = [button.domNode, titleMenu.element].map(target => this._register(hovers.setupHover({ target, content: undefined })));
		let edit: { readonly target: TitleRename; readonly restoreFocus: boolean; saving: boolean; } | undefined;
		const input = renderInlineRenameInput(titleContainer, {
			label: localize('sessions.titlebar.sessionName', 'Session name'),
			onAccept: () => { void saveEdit(); },
			onCancel: () => { if (!edit?.saving) finishEdit(true); },
			onBlur: () => { if (!edit?.saving) finishEdit(false); },
		}, this._register(new DisposableStore()));
		const beginEdit = (target: TitleRename, restoreFocus: boolean) => {
			if (edit?.saving) return;
			edit = { target, restoreFocus, saving: false };
			for (const hover of titleHovers) hover.hide();
			showInlineRenameInput(input, target.title);
			button.hidden = true;
			titleMenuHost.hidden = true;
		};
		const beginSessionEdit = (target: NonNullable<ReturnType<typeof renameTarget>>, restoreFocus: boolean) => {
			try {
				const captured = sessionActions.resolveTarget(target);
				beginEdit({
					key: JSON.stringify([mode.get(), target]), title: captured.title,
					rename: async title => sessionActions.renameSession((await captured.resolve()).sessionId, title),
				}, restoreFocus);
			} catch (error) {
				notifications.error(toErrorMessage(error));
			}
		};
		const finishEdit = (restoreFocus: boolean) => {
			const draft = edit;
			if (!draft) return;
			edit = undefined;
			updateTitleVisibility();
			if (restoreFocus && draft.restoreFocus) (combinedMenu ? titleMenu : button).focus();
			input.hidden = true;
			input.setCustomValidity('');
		};
		const updateTitleVisibility = () => {
			button.hidden = !!edit || combinedMenu;
			titleMenuHost.hidden = !!edit || !combinedMenu;
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
				await draft.target.rename(title);
				if (edit === draft && input.isConnected) finishEdit(getActiveElement(input.ownerDocument) === input);
			} catch (error) {
				notifications.error(toErrorMessage(error));
			} finally {
				if (edit === draft && input.isConnected) {
					draft.saving = false;
					input.readOnly = false;
				}
			}
		};
		let activeMenu: { readonly key: string; readonly cancellation: CancellationTokenSource; } | undefined;
		this._register(toDisposable(() => activeMenu?.cancellation.cancel()));
		const showCodeMenu = (keyboard: boolean) => {
			if (activeMenu) {
				activeMenu.cancellation.cancel();
				return;
			}
			const key = activeKey();
			const actions = getSessionActions('code', keyboard);
			if (!key || !actions.length) return;
			const cancellation = new CancellationTokenSource();
			const request = { key, cancellation };
			activeMenu = request;
			menuOpen.set(true, undefined);
			const anchor = menuButton.domNode;
			anchor.setAttribute('aria-expanded', 'true');
			const close = (reason?: ContextViewHideReason) => {
				if (activeMenu !== request) return;
				activeMenu = undefined;
				cancellation.dispose();
				menuOpen.set(false, undefined);
				anchor.setAttribute('aria-expanded', 'false');
				if (reason === ContextViewHideReason.Escape && anchor.isConnected && !element.hidden && !menuButton.hidden) menuButton.focus();
			};
			try {
				contextMenus.showContextMenu({
					getAnchor: () => anchor,
					getActions: () => actions,
					cancellationToken: cancellation.token,
					autoSelectFirstItem: true,
					onHide: (_cancelled, reason) => close(reason),
				});
			} catch (error) {
				close();
				throw error;
			}
		};
		const getRenameAction = (): (() => void) | undefined => {
			const entry = activeChat.get();
			if (entry) {
				const { rename } = entry;
				if (!rename || !canAct(entry)) return undefined;
				const key = chatTitleKey(entry);
				return () => {
					if (activeKey() === key) beginEdit({ key, title: entry.title, rename }, true);
				};
			}
			if (desktopChat.get()) return undefined;
			const target = renameTarget(sessions.activeSelection);
			if (target === undefined) return undefined;
			return () => beginSessionEdit(target, true);
		};
		const getDesktopChatActions = (): IAction[] => {
			const entry = activeChat.get();
			if (!entry || !canAct(entry)) return [];
			const key = chatTitleKey(entry);
			const actions: IAction[] = [];
			const { setPinned } = entry;
			const rename = getRenameAction();
			if (setPinned) actions.push({
				id: 'sessions.list.togglePin',
				label: entry.pinned ? localize('sessions.list.unpin', 'Unpin') : localize('sessions.list.pin', 'Pin'),
				icon: entry.pinned ? Lxicon.unpin : Lxicon.pin, enabled: true, tooltip: '',
				run: () => activeKey() === key ? setPinned(!entry.pinned) : undefined,
			});
			if (rename) actions.push({
				id: 'agentSession.rename', label: localize('sessions.list.rename', 'Rename'),
				icon: Lxicon.edit, enabled: true, tooltip: '',
				run: rename,
			});
			if (actions.length && (entry.sessionId || entry.archive || entry.remove)) actions.push(new Separator());
			if (entry.sessionId || entry.archive) {
				const archive = getChatSessionArchiveActionPresentation(getChatSessionArchiveActionWording(configuration)).archive;
				actions.push({
					id: 'agentSession.archive', label: archive.title.value, icon: archive.icon, enabled: true, tooltip: '',
					run: () => activeKey() === key ? commands.executeCommand('agentSession.archive', entry.sessionId ?? { catalogId: entry.id }) : undefined,
				});
			}
			if (entry.sessionId || entry.remove) actions.push({
				id: 'agentSession.delete', label: localize('sessions.list.delete', 'Delete'),
				icon: Lxicon.trash, class: 'ash-session-delete-action', enabled: true, tooltip: '',
				run: () => activeKey() === key ? commands.executeCommand('agentSession.delete', entry.sessionId ?? { catalogId: entry.id, preferenceKey: entry.preferenceKey }) : undefined,
			});
			return actions;
		};
		const getSessionActions = (surface: 'chat' | 'code', restoreFocus: boolean): IAction[] => {
			if (mode.get() !== surface) return [];
			const selection = sessions.activeSelection;
			const target = renameTarget(selection);
			if (!selection || target === undefined) return [];
			const targetKey = JSON.stringify([surface, target]);
			const workspaceActions = surface === 'code' && selection.kind === 'session'
				? createSessionWorkspaceActions(selection.active.session.sessionId, selection.active.threadId, management, commands)
				: [];
			const actions = Separator.join(workspaceActions, [...createSessionItemActions(selection, commands, listModel, notifications, {
				projectScope: surface,
				openInNewWindow: surface === 'code' ? () => commands.executeCommand('sessions.openInNewWindow', selection) : undefined,
			})]);
			return actions.map(action => action instanceof Separator ? action : {
				...action, run: () => {
					if (activeKey() !== targetKey) return;
					if (action.id === 'agentSession.rename') return beginSessionEdit(target, restoreFocus);
					return action.run();
				},
			});
		};
		const menuButton = this._register(new Button(element, {
			...defaultButtonStyles,
			presentation: 'quiet',
			size: 'small',
			icon: Lxicon.chevronDown,
			iconOnly: true,
			label: localize('sessions.list.moreActions', 'More Sessions Actions'),
			onClick: event => showCodeMenu(event.detail === 0),
		}));
		menuButton.domNode.classList.add('ash-titlebar-interactive-region', 'ash-sessions-titlebar-menu');
		menuButton.domNode.setAttribute('aria-haspopup', 'menu');
		menuButton.domNode.setAttribute('aria-expanded', 'false');
		const sharing = observableValue('sessionTitleSharing', false);
		const shareButton = this._register(new Button(element, {
			...defaultButtonStyles,
			presentation: 'primary',
			size: 'small',
			icon: Lxicon.share,
			label: localize('sessions.titlebar.share', 'Share'),
			onClick: async () => {
				const entry = activeChat.get();
				if (!entry?.share || !canAct(entry) || sharing.get()) return;
				sharing.set(true, undefined);
				try {
					await entry.share();
				} catch (error) {
					notifications.error(toErrorMessage(error));
				} finally {
					sharing.set(false, undefined);
				}
			},
		}));
		shareButton.domNode.classList.add('ash-titlebar-interactive-region', 'ash-sessions-titlebar-share');
		const folders = observableFromEvent(this, workspace.onDidChangeWorkspaceFolders, () => workspace.getWorkspace().folders);
		let displayedKey: string | undefined;
		this._register(autorun(reader => {
			mode.read(reader);
			picker.clear();
		}));
		this._register(autorun(reader => {
			const selection = sessions.getSelection(reader).activeSelection;
			const surface = mode.read(reader);
			const codeMode = surface === 'code';
			const useDesktopCatalog = desktopChat.read(reader);
			const entry = activeChat.read(reader);
			const count = useDesktopCatalog ? 0 : indicator.blockedSessions.read(reader).length;
			const covered = !!customViews.activeCustomView.read(reader);
			const target = renameTarget(selection);
			const key = entry ? chatTitleKey(entry) : target === undefined ? undefined : JSON.stringify([surface, target]);
			const sharePending = sharing.read(reader);
			const hasActions = useDesktopCatalog
				? !!(entry && (entry.rename || entry.setPinned || entry.archive || entry.sessionId || entry.remove))
				: !!selection && count === 0;
			combinedMenu = !codeMode && hasActions;
			element.classList.toggle('ash-sessions-titlebar-chat', useDesktopCatalog);
			element.hidden = covered || (useDesktopCatalog && !entry)
				|| (codeMode && selection?.kind === 'untitled' && count === 0);
			menuButton.hidden = !codeMode || !hasActions;
			button.enabled = !entry || hasActions && canAct(entry);
			titleAction.enabled = button.enabled;
			button.domNode.classList.toggle('ash-sessions-titlebar-editable', hasActions);
			updateTitleVisibility();
			if (!combinedMenu || element.hidden || !titleAction.enabled || key !== displayedKey) titleMenu.hide();
			displayedKey = key;
			shareButton.hidden = !entry?.share;
			// Keep the trigger focusable while the share dialog is open so it can restore focus.
			shareButton.enabled = sharePending || !!entry && canAct(entry);
			if (sharePending) shareButton.domNode.setAttribute('aria-disabled', 'true');
			else shareButton.domNode.removeAttribute('aria-disabled');
			if (activeMenu && (element.hidden || key !== activeMenu.key || menuButton.hidden)) {
				activeMenu.cancellation.cancel();
			}
			if (edit && (element.hidden || count || edit.target.key !== key)) {
				finishEdit(!element.hidden && edit.saving && getActiveElement(input.ownerDocument) === input);
			}
			if (element.hidden) {
				picker.clear();
				for (const hover of titleHovers) hover.hide();
				return;
			}
			if (entry) {
				button.icon = undefined;
				button.label = entry.title;
				button.domNode.setAttribute('aria-label', entry.title);
				titleMenu.setLabel(entry.title, localize('sessions.titlebar.chatActions', 'Chat actions ({0})', entry.title));
				for (const hover of titleHovers) hover.update(entry.title);
				return;
			}
			if (count) {
				const attention = count === 1
					? localize('sessions.blocked.one', '1 session requires attention')
					: localize('sessions.blocked.many', '{0} sessions require attention', count);
				button.icon = Lxicon.warning;
				button.label = attention;
				button.domNode.setAttribute('aria-label', attention);
				for (const hover of titleHovers) hover.update(attention);
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
			const workspaceLabel = label || localize('sessions.titlebar.noWorkspace', 'No project folder');
			const contextLabel = branch ? localize('sessions.titlebar.branch', '{0} · {1}', workspaceLabel, branch) : workspaceLabel;
			button.icon = undefined;
			const title = selection?.kind === 'session' ? selection.active.session.title : selection?.session.title;
			button.label = title ?? contextLabel;
			const accessibleName = title === undefined
				? localize('sessions.titlebar.showHistory', 'Show Session History ({0})', contextLabel)
				: localize('sessions.titlebar.renameSession', 'Rename session ({0})', title);
			button.domNode.setAttribute('aria-label', accessibleName);
			titleMenu.setLabel(button.label, localize('sessions.titlebar.chatActions', 'Chat actions ({0})', button.label));
			const workspaceDetails = path && branch ? localize('sessions.titlebar.branch', '{0} · {1}', path, branch) : path || contextLabel;
			const hoverContent = () => {
				const titleLabel = (combinedMenu ? titleMenu.element : button.domNode).querySelector('.ash-button-label');
				return titleLabel && titleLabel.scrollWidth > titleLabel.clientWidth
					? button.label
					: workspaceDetails;
			};
			for (const hover of titleHovers) hover.update(hoverContent);
		}));
		this._register(getSessionsTitlebarPart(titleService, layout.mainContainer).setSessionContent(element, menuOpen));
	}
}
