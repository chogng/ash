import { getActiveElement } from '../../../../base/browser/dom.js';
import { canceled, onUnexpectedError } from '../../../../base/common/errors.js';
import { autorun, type IReader } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { OPEN_SESSION_LINK_SCHEME, parseOpenSessionLinkUri } from '../../../../platform/agentHost/common/openSessionLink.js';
import type { SkillReference } from '../../../../platform/agentHost/common/appServerApi.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { ModelRef, ModelReasoningEffort } from '../../../../platform/models/common/agentModels.js';
import type { ResolvedChatContext } from '../../../../workbench/services/chat/common/chatContextService.js';
import { ChatRequestQueueKind, type ChatMode, type ChatSubmissionOptions } from '../../../../workbench/services/chat/common/chatService.js';
import { modelRefIdentity } from '../../../../workbench/services/chat/common/modelCatalog.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { registerReplyChatEditor, type ChatDraftModelSource, type IReplyChatEditorModel, type ReplyChatEditorOptions } from '../browser/replyChatEditor.js';
import { Disposable, DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ViewContainerLocation } from '../../../../workbench/common/views.js';
import { SessionsViewRegistry } from '../../../common/views.js';
import { ChatWidgetModel } from '../../../browser/chatWidgetModel.js';
import { ISessionPrimaryProviderServices, type SessionProviderServices } from '../../../browser/agentHost/sessionProviderScopeService.js';
import { SessionWorkspaceStatus } from '../browser/sessionWorkspaceStatus.js';
import { ASH_CHAT_SELECTED_CONTEXT, CHAT_NAVIGATION_FOCUS_CONTEXT, CHAT_WORKSPACE_LAST_BACKEND_KEY, CHAT_WORKSPACE_NAVIGATION_ID, SHOW_ASH_CHAT_COMMAND, SHOW_CHAT_WORKSPACE_COMMAND } from '../common/constants.js';
import { ChatListCatalog, ChatWorkspaceListModel, IChatListCatalog, NativeChatCatalogSource, type ChatListSource } from '../browser/chatListModel.js';
import { SessionsView } from '../../sessions/browser/views/sessionsView.js';
import type { SessionsCatalogAccessibility } from '../../sessions/browser/views/sessionsCatalogList.js';
import { ISessionsLayoutService } from '../../../services/layout/common/sessionsLayoutService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
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
	explicitModelSelection: true,
	literalServerCommands: true,
	createDraftPicker: (instantiation, footer, _visible, model) => instantiation.createInstance(SessionWorkspaceStatus, footer, model),
	accessibility: {
		focusContext: 'ashNativeChatFocused',
		verbositySetting: AccessibilityVerbositySettingId.Chat,
		hint: () => localize('sessions.chat.ashAccessibilityHint', 'Press Alt+F1 for Ash Chat accessibility help.'),
	},
} satisfies Omit<ReplyChatEditorOptions, 'model'>;

/** Binds the compact editor to a Sessions slot and contributes cross-source draft choices. */
class NativeReplyEditorModel extends ChatWidgetModel implements IReplyChatEditorModel {
	readonly memoryNamespace = 'chat' as const;
	private readonly draftModels: ChatDraftModelSource;
	protected override get useCodeModelDefaults(): boolean { return false; }
	protected override get commandInterpretation(): 'literal' { return 'literal'; }
	protected override get isCodeConversation(): boolean { return false; }
	override get mode(): ChatMode { return 'agent'; }
	override get isAutomaticModel(): boolean { return false; }

	constructor(
		modelSource: SyncDescriptor<ChatDraftModelSource>,
		@ISessionsService private readonly view: ISessionsService,
		@ISessionsManagementService management: ISessionsManagementService,
		@ISessionPrimaryProviderServices primary: SessionProviderServices,
		@ICommandService private readonly commands: ICommandService,
		@IConfigurationService configuration: IConfigurationService,
		@IStorageService storage: IStorageService,
		@IContextKeyService contexts: IContextKeyService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		const initial = view.getChatSelection();
		if (!initial) throw new Error('The compact Chat editor needs a restored Sessions selection');
		super(primary.chat, initial, management, primary.prompts, primary.models, primary.execution, configuration, storage, contexts);
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
		const models = this.untitledSessionId ? [...state.models, ...this.draftModels.models.get()] : state.models;
		return {
			...state, models, canSelectModel: state.phase !== 'submitting', canSelectAgent: false, slashCommands: [], skillSelectors: [],
			inputBlocked: state.inputBlocked || !state.selectedModel || !state.models.some(entry => modelRefIdentity(entry.model) === modelRefIdentity(state.selectedModel!)),
		};
	}

	override async selectModel(model: ModelRef): Promise<void> {
		if (this.untitledSessionId && this.draftModels.models.get().some(entry => modelRefIdentity(entry.model) === modelRefIdentity(model))) {
			return this.draftModels.selectModel(model, this);
		}
		const generation = this.composerGeneration;
		await super.selectModel(model);
		if (generation === this.composerGeneration) {
			await super.selectReasoningEffort(undefined);
			if (generation === this.composerGeneration) this.view.setChatModelPreference({ model });
		}
	}

	override async selectReasoningEffort(effort: ModelReasoningEffort | undefined): Promise<void> {
		const generation = this.composerGeneration;
		await super.selectReasoningEffort(effort);
		if (generation === this.composerGeneration) this.view.setChatModelPreference({ model: this.selectedModel, effort });
	}

	override send(text: string, _mode: ChatMode, _skills?: readonly SkillReference[], contexts?: readonly ResolvedChatContext[], options?: ChatSubmissionOptions): Promise<void> {
		return super.send(text, 'agent', undefined, contexts, {
			...options, queue: options?.queue ?? ChatRequestQueueKind.Queued,
		});
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
	readonly openCommand: string;
	readonly createDraft: (commands: ICommandService, origin: unknown) => Promise<void>;
}): void {
	registerReplyChatEditor({ ...ashChatEditor, model: new SyncDescriptor(NativeReplyEditorModel, [source.draftModels]) });
	registerAshChatAccessibility();
	registerSingleton(IChatListCatalog, new SyncDescriptor(ChatListCatalog, [[
		source.catalog,
		...(source.additionalCatalog ? [source.additionalCatalog] : []),
		new SyncDescriptor(NativeChatCatalogSource),
	]], true));

	registerChatWorkspaceNavigation(source.accessibility);
	CommandsRegistry.register('sessions.open.new', (accessor, origin) => source.createDraft(accessor.get(ICommandService), origin));

	registerWorkbenchContribution(ChatWorkspaceContribution.ID, WorkbenchPhase.BlockRestore,
		accessor => accessor.get(IInstantiationService).createInstance(ChatWorkspaceContribution, source.openCommand));
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
		openContributedChatCommand: string,
		@ISessionsLayoutService layout: ISessionsLayoutService,
		@IStorageService storage: IStorageService,
		@ISessionsService view: ISessionsService,
		@ISessionsManagementService sessions: ISessionsManagementService,
		@IOpenerService opener: IOpenerService,
	) {
		super();
		const newDraft = view.chatSelection.map(current => current?.kind === 'draft');
		const showAshChat = async (source?: unknown): Promise<void> => {
			await view.restoreChatSelection();
			if (this.isDisposed) throw canceled();
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
		this._register(CommandsRegistry.register(SHOW_CHAT_WORKSPACE_COMMAND, (accessor, source) => {
			const command = storage.get(CHAT_WORKSPACE_LAST_BACKEND_KEY, StorageScope.WORKSPACE) === 'ash' ? SHOW_ASH_CHAT_COMMAND : openContributedChatCommand;
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
				await showAshChat();
				if (!this.isDisposed && (previous === view.chatSelection.get() || previous === undefined)) {
					view.selectChatThread(address.sessionId, address.threadId);
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
						? localize('sessions.chat.ashAccessibilityHelp', 'Ash Chat has its own conversation history and drafts. Use Tab to reach the model picker and Enter to open it. In an unsent draft, selecting a ChatGPT model opens the ChatGPT draft. Enter sends a message, Shift+Enter inserts a line break, and Stop interrupts a reply. Open Accessible View to read the transcript. The Chat sidebar opens saved conversations. New starts a new draft.') + '\n\n' + localize({ bundle: 'ash.sessions', key: 'sessions.workspace.chatMenuHelp' }, 'For a saved conversation without a workspace, focus it in the sidebar and press Shift+F10, then choose Set Workspace. The input footer shows the bound folder. Once a folder is set, choose Continue in Code from the same menu to open the conversation and its history in Code.')
						: model.items.filter(item => !item.transient).map(item => item.text).filter(Boolean).join('\n\n'),
					() => focused.isConnected ? focused.focus() : widget.focusInput(), AccessibilityVerbositySettingId.Chat);
			},
		});
	}
}
