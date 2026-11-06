import { getActiveElement } from '../../../../base/browser/dom.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { AshChatSelectionService, IAshChatSelectionService } from '../browser/ashChatSelectionService.js';
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
	accessibility: {
		focusContext: 'ashNativeChatFocused',
		verbositySetting: AccessibilityVerbositySettingId.Chat,
		hint: () => localize('sessions.chat.ashAccessibilityHint', 'Press Alt+F1 for Ash Chat accessibility help.'),
	},
} satisfies Omit<ReplyChatEditorOptions, 'model'>;

export function registerChatWorkspace(webChat: {
	readonly catalog: SyncDescriptor<ChatListSource>;
	readonly draftModels: SyncDescriptor<ChatDraftModelSource>;
	readonly accessibility: Omit<SessionsCatalogAccessibility, 'focusContext'>;
	readonly openCommand: string;
}): void {
	registerSingleton(IAshChatSelectionService, AshChatSelectionService, InstantiationType.Delayed);
	registerReplyChatEditor({ ...ashChatEditor, model: new SyncDescriptor(AshChatWidgetModel, [webChat.draftModels]) });
	registerAshChatAccessibility();
	registerSingleton(IChatListCatalog, new SyncDescriptor(ChatListCatalog, [[
		webChat.catalog,
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
	) {
		super();
		const newDraft = selection.selection.map(current => current.kind === 'draft');
		this._register(CommandsRegistry.register(SHOW_ASH_CHAT_COMMAND, async (_accessor, source) => {
			await layout.openEntry({
				id: 'ashChat', workspaceMode: 'chat', activityContext: ASH_CHAT_SELECTED_CONTEXT,
				content: 'editor', sidebarContainerId: CHAT_WORKSPACE_NAVIGATION_ID,
				splash: 'chat', showEditorTabs: false,
				editorInput: {
					resource: URI.from({ scheme: ashChatEditor.scheme, path: '/page' }), label: ashChatEditor.title(),
					showBreadcrumbs: false, readOnly: true, capabilities: EditorInputCapabilities.CannotClose,
				},
				restoreCommand: SHOW_ASH_CHAT_COMMAND, newSessionCommand: 'sessions.open.new', newDraft, focus: 'editor',
			}, undefined, source === 'restore' ? { source } : undefined);
			storage.store(CHAT_WORKSPACE_LAST_BACKEND_KEY, 'ash', StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}));
		this._register(CommandsRegistry.register(SHOW_CHAT_WORKSPACE_COMMAND, accessor => {
			const command = storage.get(CHAT_WORKSPACE_LAST_BACKEND_KEY, StorageScope.WORKSPACE) === 'ash' ? SHOW_ASH_CHAT_COMMAND : openWebChatCommand;
			return accessor.get(ICommandService).executeCommand(command);
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
						? localize('sessions.chat.ashAccessibilityHelp', 'Ash Chat has its own conversation history and drafts. Use Tab to reach the model picker and Enter to open it. In an unsent draft, selecting a ChatGPT model opens the ChatGPT draft. Enter sends a message, Shift+Enter inserts a line break, and Stop interrupts a reply. Open Accessible View to read the transcript. The Chat sidebar opens saved conversations. New starts a new draft.')
						: model.items.filter(item => !item.transient).map(item => item.text).filter(Boolean).join('\n\n'),
					() => focused.isConnected ? focused.focus() : widget.focusInput(), AccessibilityVerbositySettingId.Chat);
			},
		});
	}
}
