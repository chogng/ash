import { getActiveElement } from '../../../../base/browser/dom.js';
import { canceled } from '../../../../base/common/errors.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { OPEN_SESSION_LINK_SCHEME, parseOpenSessionLinkUri } from '../../../../platform/agentHost/common/openSessionLink.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { AshChatSelectionService, IAshChatSelectionService } from '../browser/ashChatSelectionService.js';
import { AshChatSessionService, IAshChatSessionService } from '../browser/ashChatSessionService.js';
import { AshChatWidgetModel, type ChatDraftModelSource } from '../browser/ashChatWidgetModel.js';
import { registerReplyChatEditor, type ReplyChatEditorOptions } from '../browser/replyChatEditor.js';
import { Disposable, DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ViewContainerLocation } from '../../../../workbench/common/views.js';
import { SessionsViewRegistry } from '../../../common/views.js';
import { AshChatNavigationSource } from '../browser/ashChatNavigationSource.js';
import { continueInCodeHelp, SessionWorkspaceButton, sessionWorkspaceButtonHelp } from '../browser/sessionWorkspaceButton.js';
import { ASH_CHAT_SELECTED_CONTEXT, CHAT_NAVIGATION_FOCUS_CONTEXT, CHAT_WORKSPACE_LAST_BACKEND_KEY, CHAT_WORKSPACE_NAVIGATION_ID, SHOW_ASH_CHAT_COMMAND, SHOW_CHAT_WORKSPACE_COMMAND } from '../common/constants.js';
import { ChatListCatalog, ChatWorkspaceListModel, IChatListCatalog, type ChatListSource } from '../browser/chatListModel.js';
import { SessionsView } from '../../sessions/browser/views/sessionsView.js';
import type { SessionsCatalogAccessibility } from '../../sessions/browser/views/sessionsCatalogList.js';
import { ISessionsLayoutService } from '../../../services/layout/common/sessionsLayoutService.js';
import '../browser/chat.contribution.js';

const ashChatEditor = {
	id: 'sessions.editor.ashChat',
	scheme: 'ash-native-chat',
	name: 'Ash Chat',
	rootClass: 'ash-native-chat-widget',
	title: () => localize('sessions.chat.ashTitle', 'Ash Chat'),
	inputLabel: () => localize('sessions.chat.inputPlaceholder', 'Describe a task or ask a question'),
	persistentDraftScope: 'ash-chat',
	advanceWelcomePhrase: false,
	useWorkbenchModelManagement: true,
	createDraftPicker: (instantiation, footer, _visible, model) => instantiation.createInstance(SessionWorkspaceButton, footer, model, true),
	accessibility: {
		focusContext: 'ashNativeChatFocused',
		verbositySetting: AccessibilityVerbositySettingId.Chat,
		hint: () => localize('sessions.chat.ashAccessibilityHint', 'Press Alt+F1 for Ash Chat accessibility help.'),
	},
} satisfies Omit<ReplyChatEditorOptions, 'model'>;

export function registerChatWorkspace(webChat: {
	readonly catalog: SyncDescriptor<ChatListSource>;
	readonly additionalCatalog?: SyncDescriptor<ChatListSource>;
	readonly draftModels: SyncDescriptor<ChatDraftModelSource>;
	readonly accessibility: Omit<SessionsCatalogAccessibility, 'focusContext'>;
	readonly openCommand: string;
}): void {
	registerSingleton(IAshChatSelectionService, AshChatSelectionService, InstantiationType.Delayed);
	registerSingleton(IAshChatSessionService, AshChatSessionService, InstantiationType.Delayed);
	registerReplyChatEditor({ ...ashChatEditor, model: new SyncDescriptor(AshChatWidgetModel, [webChat.draftModels]) });
	registerAshChatAccessibility();
	registerSingleton(IChatListCatalog, new SyncDescriptor(ChatListCatalog, [[
		webChat.catalog,
		...(webChat.additionalCatalog ? [webChat.additionalCatalog] : []),
		new SyncDescriptor(AshChatNavigationSource),
	]], true));

	registerChatWorkspaceNavigation(webChat.accessibility);

	registerWorkbenchContribution(ChatWorkspaceContribution.ID, WorkbenchPhase.BlockRestore,
		accessor => accessor.get(IInstantiationService).createInstance(ChatWorkspaceContribution, webChat.openCommand));
}

export function registerChatWorkspaceNavigation(accessibility: Omit<SessionsCatalogAccessibility, 'focusContext'>): IDisposable {
	const registrations = new DisposableStore();
	const title = 'Chat';
	const localizationKey = { bundle: 'ash', key: 'sessions.activity.chat' };
	registrations.add(SessionsViewRegistry.registerViewContainer({
		id: CHAT_WORKSPACE_NAVIGATION_ID, title, localizationKey, location: ViewContainerLocation.Sidebar, isDefault: true, order: 2,
	}));
	registrations.add(SessionsViewRegistry.registerViews(CHAT_WORKSPACE_NAVIGATION_ID, [{
		id: CHAT_WORKSPACE_NAVIGATION_ID + '.view',
		title, localizationKey, canToggleVisibility: false,
		ctorDescriptor: new SyncDescriptor(SessionsView, [{
			input: new SyncDescriptor(ChatWorkspaceListModel),
			accessibility: { ...accessibility, focusContext: CHAT_NAVIGATION_FOCUS_CONTEXT },
		}]),
	}]));
	return registrations;
}

export class ChatWorkspaceContribution extends Disposable {
	static readonly ID = 'sessions.chatWorkspace';

	constructor(
		openWebChatCommand: string,
		@ISessionsLayoutService layout: ISessionsLayoutService,
		@IStorageService storage: IStorageService,
		@IAshChatSelectionService selection: IAshChatSelectionService,
		@IAshChatSessionService sessions: IAshChatSessionService,
		@IOpenerService opener: IOpenerService,
	) {
		super();
		const newDraft = selection.selection.map(current => current.kind === 'draft');
		const showAshChat = async (source?: unknown): Promise<void> => {
			await layout.openEntry({
				id: 'ashChat', workspaceMode: 'chat', activityContext: ASH_CHAT_SELECTED_CONTEXT,
				content: 'editor', sidebarContainerId: CHAT_WORKSPACE_NAVIGATION_ID,
				showEditorTabs: false,
				editorInput: {
					resource: URI.from({ scheme: ashChatEditor.scheme, path: '/page' }), label: ashChatEditor.title(),
					showBreadcrumbs: false, readOnly: true, capabilities: EditorInputCapabilities.CannotClose,
				},
				restoreCommand: SHOW_ASH_CHAT_COMMAND, newSessionCommand: 'sessions.open.new', newDraft, focus: 'editor',
			}, undefined, source === 'restore' ? { source } : undefined);
			storage.store(CHAT_WORKSPACE_LAST_BACKEND_KEY, 'ash', StorageScope.WORKSPACE, StorageTarget.MACHINE);
		};
		this._register(CommandsRegistry.register(SHOW_ASH_CHAT_COMMAND, (_accessor, source) => showAshChat(source)));
		this._register(CommandsRegistry.register(SHOW_CHAT_WORKSPACE_COMMAND, accessor => {
			const command = storage.get(CHAT_WORKSPACE_LAST_BACKEND_KEY, StorageScope.WORKSPACE) === 'ash' ? SHOW_ASH_CHAT_COMMAND : openWebChatCommand;
			return accessor.get(ICommandService).executeCommand(command);
		}));
		// The desktop contribution registers after the shared opener, which handles Code and other hosts.
		this._register(opener.registerOpener({
			open: async target => {
				const resource = typeof target === 'string' ? URI.parse(target) : target;
				if (resource.scheme !== OPEN_SESSION_LINK_SCHEME || resource.authority !== 'local') return false;
				let address;
				try { address = parseOpenSessionLinkUri(resource); }
				catch { return false; }
				const previous = selection.selection.get();
				const entryCommand = layout.newSessionCommand;
				const session = await sessions.read(address.sessionId);
				if (!session) return false;
				if (this.isDisposed || previous !== selection.selection.get() || entryCommand !== layout.newSessionCommand) throw canceled();
				if (session.status !== 'active' || !session.threads.some(thread => thread.threadId === address.threadId && thread.status === 'active')) {
					throw new Error(localize('chat.sessionLink.missing', 'This conversation is unavailable on this connection.'));
				}
				await showAshChat();
				if (!this.isDisposed && previous === selection.selection.get()
					&& (previous.kind !== 'thread' || previous.sessionId !== address.sessionId || previous.threadId !== address.threadId)) {
					selection.select({ kind: 'thread', sessionId: address.sessionId, threadId: address.threadId });
				}
				return true;
			},
		}));
	}
}

function registerAshChatAccessibility(): void {
	for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
		AccessibleViewRegistry.register({
			type, priority: 100, name: `sessionsAshChat${type}`, when: ContextKeyExpr.has(ashChatEditor.accessibility.focusContext),
			getProvider: accessor => {
				const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
				const widget = accessor.get(IChatWidgetService).getAllWidgets().find(candidate => candidate.visible && candidate.domNode.contains(focused));
				if (!widget?.model) return undefined;
				const model = widget.model;
				return new AccessibleContentProvider(AccessibleViewProviderId.SessionsChat, { type },
					() => type === AccessibleViewType.Help
						? localize('sessions.chat.ashAccessibilityHelp', 'Ash Chat has its own conversation history and drafts. Use Tab to reach the model picker and Enter to open it. In an unsent draft, selecting a ChatGPT model opens the ChatGPT draft. Enter sends a message, Shift+Enter inserts a line break, and Stop interrupts a reply. Open Accessible View to read the transcript. The Chat sidebar opens saved conversations. New starts a new draft.') + '\n\n' + sessionWorkspaceButtonHelp() + '\n\n' + continueInCodeHelp()
						: model.items.filter(item => !item.transient).map(item => item.text).filter(Boolean).join('\n\n'),
					() => focused.isConnected ? focused.focus() : widget.focusInput(), AccessibilityVerbositySettingId.Chat);
			},
		});
	}
}
