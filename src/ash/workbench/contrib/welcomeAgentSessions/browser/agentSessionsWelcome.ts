import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Emitter } from '../../../../base/common/event.js';
import { canceled } from '../../../../base/common/errors.js';
import { MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkspacesService, recentWorkspaceUri } from '../../../../platform/workspaces/common/workspaces.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import type { EditorInputSerializer } from '../../../services/editor/common/editorInputSerializer.js';
import { captureChatDraft } from '../../../services/chat/common/chatContextService.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { takeTransferredChatDraft } from '../../chat/browser/actions/chatTransfer.js';
import type { IWorkspacePickerDelegate, IWorkspacePickerItem, IQuickChatSession, IChatViewPane } from '../../chat/browser/chat.js';
import { CHAT_VIEW_ID, OPEN_CHAT_COMMAND_ID, SHOW_CHAT_HISTORY_COMMAND_ID } from '../../chat/common/chat.js';
import { AgentSessionsWelcomeInput } from './agentSessionsWelcomeInput.js';
import './media/agentSessionsWelcome.css';

/** Welcome owns target selection and handoff; the Chat view retains the model and unsent draft. */
export class AgentSessionsWelcomePage extends EditorPane {
	public static readonly ID = 'workbench.editor.agentSessionsWelcome';
	public readonly id = AgentSessionsWelcomePage.ID;
	private root!: HTMLElement;
	private chatHost!: HTMLElement;
	private readonly mount = this._register(new MutableDisposable<IQuickChatSession>());
	private readonly selectedChanged = this._register(new Emitter<IWorkspacePickerItem | undefined>());
	private readonly workspacesChanged = this._register(new Emitter<void>());
	private selectedWorkspace: IWorkspacePickerItem | undefined;
	private workspaces: IWorkspacePickerItem[] = [];
	private historyGeneration = 0;
	private shown = false;
	private input: AgentSessionsWelcomeInput | undefined;

	constructor(
		@IViewsService private readonly views: IViewsService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IWorkspacesService private readonly history: IWorkspacesService,
		@IWorkspaceTrustManagementService private readonly trust: IWorkspaceTrustManagementService,
		@IHostService private readonly host: IHostService,
		@ICommandService private readonly commands: ICommandService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@INotificationService private readonly notifications: INotificationService,
		@IAccessibleViewService private readonly accessibleViews: IAccessibleViewService,
		@ILifecycleService private readonly lifecycle: ILifecycleService,
		@IThemeService theme: IThemeService,
		@IStorageService private readonly storage: IStorageService,
	) {
		super(AgentSessionsWelcomePage.ID, theme, storage);
		this._register(history.onDidChangeRecentlyOpened(() => { void this.refreshWorkspaces(); }));
		this._register(trust.onDidChangeTrustedFolders(() => { void this.refreshWorkspaces(); }));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ChatAIDisabledSettingId)) { this.updateVisibility(); }
		}));
	}

	public override create(parent: HTMLElement): void {
		this.root = h(parent.ownerDocument, 'section', { className: 'ash-agent-sessions-welcome' });
		this.root.tabIndex = -1;
		this.root.setAttribute('aria-label', localize('agentSessionsWelcome.title', 'Agent Sessions Welcome'));
		parent.append(this.root);
		super.create(this.root);
		this._register(toDisposable(() => this.root.remove()));
		const content = h(parent.ownerDocument, 'div', { className: 'ash-agent-sessions-welcome-content' });
		const title = h(parent.ownerDocument, 'h1');
		title.id = 'ash-agent-sessions-welcome-title';
		title.textContent = localize('agentSessionsWelcome.heading', 'What would you like to work on?');
		const actions = h(parent.ownerDocument, 'div', { className: 'ash-agent-sessions-welcome-actions' });
		for (const [label, command] of [
			[localize('agentSessionsWelcome.openChat', 'Open in Chat View'), OPEN_CHAT_COMMAND_ID],
			[localize('agentSessionsWelcome.history', 'Chat History'), SHOW_CHAT_HISTORY_COMMAND_ID],
		] as const) {
			this._register(new Button(actions, {
				...defaultButtonStyles, label, size: 'small',
				onClick: () => {
					void this.runHostAction(command).catch(error => this.notifications.error(error));
				},
			}));
		}
		this.chatHost = h(parent.ownerDocument, 'div', { className: 'ash-agent-sessions-welcome-chat' });
		content.append(title, this.chatHost, actions);
		this.root.append(content);
		this._register(AccessibleViewRegistry.register({
			name: 'agentSessionsWelcome', priority: 115, type: AccessibleViewType.Help,
			getProvider: () => this.shown && this.root.contains(this.root.ownerDocument.activeElement)
				&& !this.mount.value?.widget.domNode.contains(this.root.ownerDocument.activeElement)
				? new AccessibleContentProvider(AccessibleViewProviderId.GettingStarted, { type: AccessibleViewType.Help },
					() => localize('agentSessionsWelcome.help', 'Agent Sessions Welcome\nUse Tab to reach the message input, Workspace, Open in Chat View and Chat History. Enter sends a message in the current workspace. In an empty window, select a trusted recent workspace first to open it with your message and attachments prefilled. The target never sends automatically. A failed open keeps your draft here. Workspace opens with Enter, Space or an arrow key; use arrow keys to choose and Escape to return. Open in Chat View moves this same conversation and draft to Chat.'),
					() => this.focus(), AccessibilityVerbositySettingId.GettingStarted) : undefined,
		}));
		this._register(addDisposableListener(this.root, 'focusin', event => {
			if (!this.root.contains(event.relatedTarget as Node | null)) {
				const hint = this.accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.GettingStarted);
				if (hint) { this.root.setAttribute('aria-description', hint); }
			}
		}));
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		if (!(input instanceof AgentSessionsWelcomeInput)) { throw new TypeError('Invalid Agent Sessions Welcome input'); }
		signal.throwIfAborted();
		this.input = input;
		if (this.configuration.getValue<boolean>(ChatAIDisabledSettingId)) { throw canceled(); }
		if (!this.mount.value) {
			const wasVisible = this.views.isViewVisible(CHAT_VIEW_ID);
			const view = await this.views.openView<IChatViewPane>(CHAT_VIEW_ID);
			signal.throwIfAborted();
			if (this.isDisposed) { throw canceled(); }
			if (!wasVisible) { this.views.closeView(CHAT_VIEW_ID); }
			if (!view || typeof view.createEmbeddedChat !== 'function') { throw new Error(localize('agentSessionsWelcome.unavailable', 'Chat is unavailable in this window.')); }
			const delegate: IWorkspacePickerDelegate | undefined = this.workspace.getWorkbenchState() === WorkbenchState.EMPTY ? {
				getWorkspaces: () => this.workspaces,
				getSelectedWorkspace: () => this.selectedWorkspace,
				setSelectedWorkspace: workspace => { this.selectedWorkspace = workspace; this.selectedChanged.fire(workspace); },
				onDidChangeSelectedWorkspace: this.selectedChanged.event,
				onDidChangeWorkspaces: this.workspacesChanged.event,
				openFolderCommand: 'workbench.action.files.openFolder',
			} : undefined;
			this.mount.value = view.createEmbeddedChat(this.chatHost, 'ash-agent-sessions-welcome-title', {
				workspacePickerDelegate: delegate,
				submitHandler: async (query, mode, contexts, submissionSignal) => {
					const target = this.selectedWorkspace;
					if (!target || !(await this.trust.getUriTrustInfo(target.uri)).trusted) { return false; }
					const draft = await captureChatDraft(query, mode, contexts);
					if (this.isDisposed || submissionSignal?.aborted || this.selectedWorkspace !== target) { throw canceled(); }
					const key = `chat.welcomeViewPrefill:${target.uri.toString()}`;
					const value = JSON.stringify({ timestamp: Date.now(), payload: { draft } });
					this.storage.store(key, value, StorageScope.APPLICATION, StorageTarget.MACHINE);
					try {
						await this.storage.flush();
						if (submissionSignal?.aborted || this.isDisposed) { throw canceled(); }
						await this.host.openWindow([target.isFolder ? { folderUri: target.uri } : { workspaceUri: target.uri }], { forceNewWindow: true });
						return true;
					} catch (error) {
						if (this.storage.get(key, StorageScope.APPLICATION) === value) { this.storage.remove(key, StorageScope.APPLICATION); }
						throw error;
					}
				},
			});
			if (this.lifecycle.phase >= LifecyclePhase.Restored) {
				await this.applyPrefill();
			} else {
				// Inactive editors can be restored before the startup handoff chooses its foreground tab.
				// Leave the payload visible to that contribution until restoration has finished.
				void this.lifecycle.when(LifecyclePhase.Restored).then(() => this.applyPrefill()).catch(error => {
					if (!this.isDisposed) { this.notifications.error(error instanceof Error ? error : String(error)); }
				});
			}
		}
		await this.refreshWorkspaces();
		signal.throwIfAborted();
		this.updateVisibility();
	}

	public override clearInput(): void { this.input = undefined; this.mount.value?.setVisible(false); }
	public override layout(_dimension: IDimension): void { }
	public override setVisible(visible: boolean): void { super.setVisible(visible); this.shown = visible; this.updateVisibility(); }
	public override focus(): void { this.mount.value?.widget.focusInput(); }

	private async runHostAction(command: string): Promise<void> {
		const input = this.input;
		if (command === OPEN_CHAT_COMMAND_ID) { this.mount.value?.reveal(); }
		await this.commands.executeCommand(command);
		if (command === OPEN_CHAT_COMMAND_ID && input && !this.isDisposed) { await this.group?.closeEditor(input); }
	}

	private updateVisibility(): void {
		if (!this.root) { return; }
		const visible = this.shown && !this.configuration.getValue<boolean>(ChatAIDisabledSettingId);
		this.root.hidden = !visible;
		this.mount.value?.setVisible(visible);
	}

	private async refreshWorkspaces(): Promise<void> {
		const generation = ++this.historyGeneration;
		try {
			const recent = await this.history.getRecentlyOpened();
			const trusted = await Promise.all(recent.workspaces.map(async item => {
				const uri = recentWorkspaceUri(item);
				return (await this.trust.getUriTrustInfo(uri)).trusted ? [{ uri, label: item.label || basename(uri), isFolder: 'folderUri' in item }] : [];
			}));
			if (this.isDisposed || generation !== this.historyGeneration) { return; }
			this.workspaces = trusted.flat();
			if (this.selectedWorkspace && !this.workspaces.some(item => item.uri.toString() === this.selectedWorkspace!.uri.toString())) {
				this.selectedWorkspace = undefined;
				this.selectedChanged.fire(undefined);
			}
			this.workspacesChanged.fire();
		} catch (error) { if (!this.isDisposed && generation === this.historyGeneration) { this.notifications.error(error instanceof Error ? error : String(error)); } }
	}

	private async applyPrefill(): Promise<void> {
		if (this.isDisposed) { return; }
		const draft = await takeTransferredChatDraft(this.workspace.getWorkspace(), this.storage, this.trust);
		if (draft && !this.isDisposed) { this.mount.value?.widget.restoreDraft(draft); }
	}
}

export class AgentSessionsWelcomeInputSerializer implements EditorInputSerializer {
	public readonly typeId = AgentSessionsWelcomeInput.TYPE_ID;
	public canSerialize(input: IResourceEditorInput): boolean { return input instanceof AgentSessionsWelcomeInput; }
	public serialize(_input: IResourceEditorInput): unknown { return { version: 1 }; }
	public deserialize(value: unknown): AgentSessionsWelcomeInput {
		if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) { throw new TypeError('Invalid Welcome editor input'); }
		return new AgentSessionsWelcomeInput();
	}
}
