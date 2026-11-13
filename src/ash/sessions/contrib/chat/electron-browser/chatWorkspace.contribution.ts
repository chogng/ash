import { getActiveElement } from '../../../../base/browser/dom.js';
import { canceled, onUnexpectedError } from '../../../../base/common/errors.js';
import { autorun, type IReader } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { OPEN_SESSION_LINK_SCHEME, parseOpenSessionLinkUri } from '../../../../platform/agentHost/common/openSessionLink.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { ModelRef, ModelReasoningEffort } from '../../../../platform/models/common/agentModels.js';
import { modelRefIdentity } from '../../../../workbench/services/chat/common/modelCatalog.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { getChatCodeBlockCardAccessibilityHelp, getChatRequestAccessibilityHelp, getChatTableAccessibilityHelp } from '../../../../workbench/contrib/chat/browser/actions/chatAccessibilityHelp.js';
import { getSessionsListGroupingHelp } from '../../sessions/browser/views/sessionsListActions.js';
import type { IChatListItem } from '../../../../workbench/contrib/chat/common/model/chatViewModel.js';
import { IChatViewFactory, type ChatDraftModelSource, type ICompactChatModel, type IChatViewSource } from '../browser/chatViewFactory.js';
import { Disposable, DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ViewContainerLocation } from '../../../../workbench/common/views.js';
import { SessionsViewRegistry } from '../../../common/views.js';
import { ISessionPrimaryProviderServices, type SessionProviderServices } from '../../../browser/agentHost/sessionProviderScopeService.js';
import { AshChatModel } from '../browser/ashChatModel.js';
import { registerChatEntityDetails } from '../browser/chatEntityDetails.js';
import { SessionWorkspaceStatus } from '../browser/sessionWorkspaceStatus.js';
import { ASH_CHAT_SELECTED_CONTEXT, CHAT_NAVIGATION_FOCUS_CONTEXT, CHAT_WORKSPACE_ENTRY_REQUEST, CHAT_WORKSPACE_LAST_BACKEND_KEY, CHAT_WORKSPACE_NAVIGATION_ID, SHOW_ASH_CHAT_COMMAND, SHOW_CHAT_WORKSPACE_COMMAND } from '../common/constants.js';
import { ChatListCatalog, ChatWorkspaceListModel, IChatListCatalog, NativeChatCatalogSource, type ChatListSource } from '../browser/chatListModel.js';
import { registerNativeConversationSharing } from '../browser/nativeConversationShare.js';
import { SessionsView } from '../../sessions/browser/views/sessionsView.js';
import type { SessionsCatalogAccessibility } from '../../sessions/browser/views/sessionsCatalogList.js';
import { ISessionsEntryService, type ISessionsEntry } from '../../../services/layout/common/sessionsEntryService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { IGeneratedFilesService } from '../../../services/generatedFiles/common/generatedFilesService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { INativeChatModelPreferencesService } from '../common/nativeChatModelPreferencesService.js';
import '../browser/chat.contribution.js';

const ashChatViewSource = {
	id: 'sessions.editor.ashChat',
	rootClass: 'ash-native-chat-widget',
	title: () => localize('sessions.chat.ashTitle', 'Ash Chat'),
	inputLabel: () => localize('sessions.chat.inputPlaceholder', 'Describe a task or ask a question'),
	persistentDraftScope: 'ash-chat',
	advanceWelcomePhrase: false,
	useWorkbenchModelManagement: true,
	explicitModelSelection: true,
	createDraftPicker: (instantiation, footer, _visible, model) => instantiation.createInstance(SessionWorkspaceStatus, footer, model),
	accessibility: {
		focusContext: 'ashNativeChatFocused',
		verbositySetting: AccessibilityVerbositySettingId.Chat,
		hint: () => localize('sessions.chat.ashAccessibilityHint', 'Press Alt+F1 for Ash Chat accessibility help.'),
	},
} satisfies Omit<IChatViewSource, 'model'>;

/** Binds the compact Chat view to the native selection and contributes cross-source draft choices. */
class NativeChatWorkspaceModel extends AshChatModel implements ICompactChatModel {
	private readonly draftModels: ChatDraftModelSource;

	constructor(
		modelSource: SyncDescriptor<ChatDraftModelSource>,
		@ISessionsService private readonly view: ISessionsService,
		@ISessionsManagementService private readonly management: ISessionsManagementService,
		@ISessionPrimaryProviderServices primary: SessionProviderServices,
		@ICommandService private readonly commands: ICommandService,
		@IConfigurationService configuration: IConfigurationService,
		@IStorageService storage: IStorageService,
		@IGeneratedFilesService generatedFiles: IGeneratedFilesService,
		@IContextKeyService contexts: IContextKeyService,
		@IInstantiationService instantiation: IInstantiationService,
		@INativeChatModelPreferencesService modelPreferences: INativeChatModelPreferencesService,
	) {
		const initial = view.getChatSelection();
		if (!initial) throw new Error('The compact Chat view needs a restored Sessions selection');
		super(initial, 'compact', management, primary.chat, primary.prompts, primary.models, primary.execution, configuration, storage, generatedFiles, contexts, modelPreferences);
		this.draftModels = instantiation.createInstance(modelSource);
		let previous: ReturnType<typeof view.chatSelection.get>;
		this._register(autorun(reader => {
			const selection = view.getChatSelection(reader);
			const reference = view.chatSelection.read(reader);
			if (selection) this.bindSelection(selection);
			if (reference !== previous && reference?.kind === 'thread' && this.threadId === reference.threadId) {
				this.restoreThreadModel(reference.model, reference.effort);
			}
			if (reference?.kind === 'draft') {
				this.draftModels.models.read(reader);
				if (previous?.kind !== 'draft' || previous.id !== reference.id) this.draftModels.initialize();
			}
			previous = reference;
			this.notifyModelChoicesChanged();
		}));
	}

	override get inputState() {
		const state = super.inputState;
		return this.untitledSessionId ? { ...state, models: [...state.models, ...this.draftModels.models.get()] } : state;
	}

	override async selectModel(model: ModelRef): Promise<void> {
		if (this.untitledSessionId && this.draftModels.models.get().some(entry => modelRefIdentity(entry.model) === modelRefIdentity(model))) {
			return this.draftModels.selectModel(model, this);
		}
		const generation = this.composerGeneration;
		await super.selectModel(model);
		if (generation === this.composerGeneration) this.view.setChatModelPreference({ model });
	}

	override async selectReasoningEffort(effort: ModelReasoningEffort | undefined): Promise<void> {
		const generation = this.composerGeneration;
		await super.selectReasoningEffort(effort);
		if (generation === this.composerGeneration) this.view.setChatModelPreference({ model: this.selectedModel, effort });
	}

	async submitRequestEdit(item: IChatListItem, text: string, commandId: string): Promise<void> {
		const source = item.requestSource;
		if (!source || source.sessionId !== this.sessionId || source.threadId !== this.threadId) throw canceled();
		const generation = this.composerGeneration;
		const revision = this.view.navigationRevision;
		const isCurrent = () => !this.isDisposed && generation === this.composerGeneration && revision === this.view.navigationRevision;
		const target = await this.chatService.rewriteRequest({ ...source, text, commandId });
		if (!isCurrent()) return;
		await this.management.prepareThread(target.sessionId, target.threadId);
		if (isCurrent()) this.view.selectChatThread(target.sessionId, target.threadId);
	}

	newChat(): void { void this.commands.executeCommand('sessions.open.new').catch(onUnexpectedError); }

	readWelcomeDraft(reader: IReader) {
		const reference = this.view.chatSelection.read(reader);
		const id = reference?.kind === 'draft' ? reference.id : reference?.threadId === this.threadId ? this.welcomeDraftId : undefined;
		return id ? { id, revision: 0 } : undefined;
	}
}

export function registerChatWorkspace(source: {
	readonly catalog: SyncDescriptor<ChatListSource>;
	readonly additionalCatalog?: SyncDescriptor<ChatListSource>;
	readonly draftModels: SyncDescriptor<ChatDraftModelSource>;
	readonly accessibility: Omit<SessionsCatalogAccessibility, 'focusContext'>;
	readonly resumeCommand: (lastBackend: string | undefined) => string;
	readonly createDraft: (commands: ICommandService, origin: unknown) => Promise<void>;
}): void {
	registerAshChatAccessibility();
	registerChatEntityDetails();
	registerNativeConversationSharing();
	registerSingleton(IChatListCatalog, new SyncDescriptor(ChatListCatalog, [[
		source.catalog,
		...(source.additionalCatalog ? [source.additionalCatalog] : []),
		new SyncDescriptor(NativeChatCatalogSource),
	]], true));

	registerChatWorkspaceNavigation(source.accessibility);
	CommandsRegistry.register('sessions.open.new', (accessor, origin) => source.createDraft(accessor.get(ICommandService), origin));

	registerWorkbenchContribution(ChatWorkspaceContribution.ID, WorkbenchPhase.BlockRestore,
		accessor => accessor.get(IInstantiationService).createInstance(ChatWorkspaceContribution, source.resumeCommand, source.draftModels));
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
		resumeContributedChat: (lastBackend: string | undefined) => string,
		draftModels: SyncDescriptor<ChatDraftModelSource>,
		@ISessionsEntryService layout: ISessionsEntryService,
		@IStorageService storage: IStorageService,
		@ISessionsService view: ISessionsService,
		@ISessionsManagementService sessions: ISessionsManagementService,
		@IOpenerService opener: IOpenerService,
		@IChatViewFactory chatViews: IChatViewFactory,
	) {
		super();
		const chatSource = 'ashChat';
		this._register(chatViews.registerSource(chatSource, { ...ashChatViewSource, model: new SyncDescriptor(NativeChatWorkspaceModel, [draftModels]) }));
		const newDraft = view.chatSelection.map(current => current?.kind === 'draft');
		const entry: ISessionsEntry = {
			id: chatSource, workspaceMode: 'chat', activityContext: ASH_CHAT_SELECTED_CONTEXT,
			content: 'conversation', sidebarContainerId: CHAT_WORKSPACE_NAVIGATION_ID, chatSource,
			restoreCommand: SHOW_ASH_CHAT_COMMAND, newSessionCommand: 'sessions.open.new', newDraft, focus: 'conversation',
		};
		const openAshChat = async (source?: unknown): Promise<void> => {
			if (this.isDisposed) throw canceled();
			await layout.openEntry(entry, undefined, source === 'restore' ? { source } : undefined);
			storage.store(CHAT_WORKSPACE_LAST_BACKEND_KEY, 'ash', StorageScope.WORKSPACE, StorageTarget.MACHINE);
		};
		this._register(CommandsRegistry.register(SHOW_ASH_CHAT_COMMAND, async (_accessor, source) => {
			await view.restoreChatSelection();
			if (source === CHAT_WORKSPACE_ENTRY_REQUEST) return entry;
			await openAshChat(source);
		}));
		this._register(CommandsRegistry.register(SHOW_CHAT_WORKSPACE_COMMAND, (accessor, source) => {
			const lastBackend = storage.get(CHAT_WORKSPACE_LAST_BACKEND_KEY, StorageScope.WORKSPACE);
			const command = lastBackend === 'ash' ? SHOW_ASH_CHAT_COMMAND : resumeContributedChat(lastBackend);
			return accessor.get(ICommandService).executeCommand(command, source);
		}));
		// The desktop contribution registers after the shared opener, which handles Code and other hosts.
		this._register(opener.registerOpener({
			open: async target => {
				const resource = typeof target === 'string' ? URI.parse(target) : target;
				if (resource.scheme !== OPEN_SESSION_LINK_SCHEME || resource.authority !== 'local') return false;
				let address;
				try { address = parseOpenSessionLinkUri(resource); }
				catch { return false; }
				const previous = view.chatSelection.get();
				const entryCommand = layout.newSessionCommand;
				const session = await sessions.readCatalog(address.sessionId);
				if (session?.kind !== 'chat' || session.backendSessionId !== undefined) return false;
				if (this.isDisposed || previous !== view.chatSelection.get() || entryCommand !== layout.newSessionCommand) throw canceled();
				if (session.status !== 'active' || !session.chats.some(thread => thread.threadId === address.threadId && thread.status === 'active')) {
					throw new Error(localize('chat.sessionLink.missing', 'This conversation is unavailable on this connection.'));
				}
				if (!sessions.sessions.some(candidate => candidate.sessionId === address.sessionId
					&& candidate.status === 'active' && candidate.chats.some(thread => thread.threadId === address.threadId && thread.status === 'active'))) {
					await sessions.prepareThread(address.sessionId, address.threadId);
					if (this.isDisposed || previous !== view.chatSelection.get() || entryCommand !== layout.newSessionCommand) throw canceled();
				}
				// The Chat view needs a selection during construction. An explicit link supplies its own.
				view.selectChatThread(address.sessionId, address.threadId);
				await openAshChat();
				return true;
			},
		}));
	}
}

function registerAshChatAccessibility(): void {
	for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
		AccessibleViewRegistry.register({
			type, priority: 100, name: `sessionsAshChat${type}`, when: ContextKeyExpr.has(ashChatViewSource.accessibility.focusContext),
			getProvider: accessor => {
				const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
				const widget = accessor.get(IChatWidgetService).getAllWidgets().find(candidate => candidate.visible && candidate.domNode.contains(focused));
				if (!widget?.model) return undefined;
				const model = widget.model;
				return new AccessibleContentProvider(AccessibleViewProviderId.SessionsChat, { type },
					() => type === AccessibleViewType.Help
						? localize('sessions.chat.ashAccessibilityHelp', 'Ash Chat has its own conversation history and drafts. Use Tab to reach the model picker and Enter to open it. In an unsent draft, selecting a ChatGPT model opens the ChatGPT draft. Enter sends a message, Shift+Enter inserts a line break, and Stop interrupts a reply. Open Accessible View to read the transcript. The Chat sidebar opens saved conversations. New starts a new draft.') + '\n\n' + localize({ bundle: 'ash.sessions', key: 'sessions.workspace.chatMenuHelp' }, 'For a saved conversation without a workspace, focus it in the sidebar and press Shift+F10, then choose Set Workspace. The input footer shows the bound folder. Once a folder is set, choose Continue in Code from the same menu to open the conversation and its history in Code.')
						+ '\n\n' + getSessionsListGroupingHelp()
						+ '\n\n' + getChatRequestAccessibilityHelp(true)
						+ '\n\n' + localize('sessions.chat.ashResponseActionsHelp', 'Use Tab to reach the response toolbar, then use the arrow keys to move between actions. Share asks for confirmation before sharing the conversation through this response. Fork starts a new Ash conversation through this response.')
						+ '\n\n' + getChatCodeBlockCardAccessibilityHelp()
						+ '\n\n' + getChatTableAccessibilityHelp()
						+ '\n\n' + localize('sessions.chat.versionsHelp', 'For a conversation with edits, open More actions on its sidebar row and choose Conversation versions. Use Right Arrow to open the submenu and Enter to open a version.')
						+ '\n\n' + localize('sessions.list.forkSidebarHelp', 'In the sidebar, Tab to the Fork icon and press Enter to open its source conversation. Focus Conversation branches and press Enter to expand or collapse the tree. On the conversation row, Right Arrow expands the tree or moves to its first branch, and Left Arrow collapses it.')
						+ '\n\n' + localize('sessions.titlebar.ashChatHelp', 'For a saved chat, focus its title and press Enter or Down Arrow to open the actions menu. Choose Rename or double-click the title to edit it in place. Press Enter to save or Escape to cancel. The menu also offers pin, archive, and delete actions when available. Share at the right of the title bar asks for confirmation before creating and copying a link to the conversation text.')
						: model.items.filter(item => !item.transient).map(item => item.text).filter(Boolean).join('\n\n'),
					() => focused.isConnected ? focused.focus() : widget.focusInput(), AccessibilityVerbositySettingId.Chat);
			},
		});
	}
}
