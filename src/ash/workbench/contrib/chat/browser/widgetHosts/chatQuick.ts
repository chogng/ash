import './media/chatQuick.css';
import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Orientation, Sash } from '../../../../../base/browser/ui/sash/sash.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { clamp } from '../../../../../base/common/numbers.js';
import { localize } from '../../../../../nls.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { buildOpenSessionLinkUri } from '../../../../../platform/agentHost/common/openSessionLink.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickWidget } from '../../../../../platform/quickinput/common/quickInput.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IsSessionsWindowContext } from '../../../../common/contextkeys.js';
import { CHAT_VIEW_ID } from '../../common/chat.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import type { IQuickChatOpenOptions, IQuickChatService, IQuickChatSession } from '../chat.js';
import { ChatViewPane } from './viewPane/chatViewPane.js';

let quickChatId = 0;

/** Window-owned overlay. Conversation state and the retained editor belong to its Chat view. */
export class QuickChatService extends Disposable implements IQuickChatService {
	private readonly closed = this._register(new Emitter<void>());
	readonly onDidClose = this.closed.event;
	private readonly retiredSession = this._register(new MutableDisposable());
	private readonly root: HTMLElement;
	private readonly content: HTMLElement;
	private readonly titleId: string;
	private readonly resizeSash: Sash;
	private preferredHeight: number | undefined;
	private input: IQuickWidget | undefined;
	private session: IQuickChatSession | undefined;
	private opening = 0;
	private partialQuery: string | undefined;
	private movingToView = false;

	constructor(
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IViewsService private readonly views: IViewsService,
		@IWorkbenchLayoutService private readonly layout: IWorkbenchLayoutService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IContextKeyService private readonly contexts: IContextKeyService,
		@INotificationService private readonly notifications: INotificationService,
		@IAccessibilityService private readonly accessibility: IAccessibilityService,
	) {
		super();
		const document = layout.mainContainer.ownerDocument;
		this.root = h(document, 'section', { className: 'ash-quick-chat' });
		this.titleId = `ash-quick-chat-${++quickChatId}`;
		this.root.setAttribute('role', 'dialog');
		this.root.setAttribute('aria-labelledby', this.titleId);
		const header = h(document, 'div', { className: 'ash-quick-chat-header' });
		const title = h(document, 'span');
		title.id = this.titleId;
		title.textContent = localize('quickChat.title', 'Quick Chat');
		title.title = title.textContent;
		header.append(title);
		this._register(new Button(header, {
			...defaultButtonStyles, size: 'small', presentation: 'quiet',
			label: localize('quickChat.openInView', 'Open in Chat View'),
			onClick: () => { void this.openInChatView().catch(error => this.report(error)); },
		}));
		this._register(new Button(header, {
			...defaultButtonStyles, size: 'small', presentation: 'quiet',
			label: localize('quickChat.close', 'Close'), onClick: () => this.close(),
		}));
		this.content = h(document, 'div', { className: 'ash-quick-chat-content' });
		this.root.append(header, this.content);
		const sash = this.resizeSash = this._register(new Sash(this.root, { getHorizontalSashTop: () => this.root.clientHeight - 2 }, { orientation: Orientation.HORIZONTAL }));
		sash.element.setAttribute('aria-label', localize('quickChat.resize', 'Resize Quick Chat'));
		let startHeight = 0;
		this._register(sash.onDidStart(() => { startHeight = this.root.offsetHeight; }));
		this._register(sash.onDidChange(event => {
			const height = (event.input === 'keyboard' ? this.root.offsetHeight : startHeight) + event.currentY - event.startY;
			this.preferredHeight = height;
			this.updateLayout();
		}));
		this._register(sash.onDidReset(() => { this.preferredHeight = undefined; this.updateLayout(); }));
		this._register(layout.onDidLayoutActiveContainer(() => this.updateLayout()));
		const scope = this._register(contexts.createScoped(this.root));
		ChatContextKeys.inQuickChat.bindTo(scope).set(true);
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ChatAIDisabledSettingId) && !this.enabled) this.close();
		}));
		this._register(addDisposableListener(this.root, 'focusin', event => {
			if (!this.root.contains(event.relatedTarget as Node | null) && configuration.getValue<boolean>(AccessibilityVerbositySettingId.QuickChat) !== false) {
				accessibility.status(localize('quickChat.accessibilityHint', 'Quick Chat. Use the accessibility help command for keyboard instructions.'));
			}
		}));
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				name: 'quickChat', type, priority: 120,
				getProvider: () => {
					const session = this.session;
					if (!this.focused || !session) return undefined;
					const provider = new AccessibleContentProvider(AccessibleViewProviderId.QuickChat, { type },
						() => type === AccessibleViewType.Help
							? localize('quickChat.accessibilityHelp', 'Quick Chat is a separate conversation that keeps your main Chat selection. Type a message and press Enter to send; use Shift+Enter for a new line. Use Tab and Shift+Tab to reach attachments, model controls, Open in Chat View and Close. Escape closes the overlay and returns focus to your previous editor. Reopen with <keybinding:workbench.action.quickchat.toggle> to continue. Open in Chat View continues the same conversation, including its draft, attachments and running response. Use the accessible view command to read the conversation as text.') + '\n' + localize('chat.remainingActions.help', 'Chat: Configure Tools edits the focused draft’s tool selection; Escape discards changes. Chat: Approve Tool Once and Chat: Decline Tool act only on the currently displayed approval. They never save an approval rule. Chat: Submit Requested Answers submits the current question form with its entered values; required answers must be filled. Use Ctrl or Command+Enter while the question form has focus. Chat: Retry Failed Request repeats an available failed request through its original retry policy. Chat: Copy Final Response copies the latest completed assistant reply without speaker labels or streaming text. Chat: Next Code Block and Chat: Previous Code Block move focus through the current or latest response’s code blocks and wrap at the ends. Use Ctrl or Command+Alt+Page Down or Page Up in Chat. Chat: Export Conversation Transcript saves a frozen backend text snapshot, including voice transcripts and partial markers. Chat: Open Saved Transcript (Read-Only) opens a supported saved document in a read-only editor; it does not restore or execute a conversation. These commands keep the unsent draft.') + '\n' + localize('chat.pickers.commandHelp', 'Use Chat: Open Model Picker, Chat: Open Mode or Agent Picker, or Chat: Open Permission Picker in the Command Palette to configure the most recently focused composer. Model and mode pickers also open with {0} and {1}. Fixed-mode inputs keep the mode picker hidden. Cowork uses its existing permission flow. Escape closes a picker. Opening or cancelling keeps the draft and attachments without sending. Switching conversations retires pending selections and permission confirmations.', '<keybinding:workbench.action.chat.openModelPicker>', '<keybinding:workbench.action.chat.openModePicker>') + '\n' + localize('chat.execution.help', 'Chat: Send Message uses the current draft, attachments and submission policy. Chat: Add Message to Queue waits for the current request to finish; Chat: Steer with Message explicitly targets it. When idle, both send normally. Explicit steering rejects a different mode, Skill or task type. Queue and steering actions do not run slash commands. Failed submissions restore the draft if it has not been edited again. Use {0} to stop the focused task while keeping unsent text. Stopping remains available for running work when AI features are disabled.', '<keybinding:workbench.action.chat.cancel>') + '\n' + localize('chat.queue.manageHelp', 'Use Chat: Edit Queued Message, Chat: Remove Queued Message or Chat: Send Queued Message Immediately in the Command Palette, then select a message in queue order. Editing pauses that message and preserves attached inputs and your unsent draft. Ctrl or Command+Enter saves; Escape restores a previously pending message at its original position. Previously paused or failed messages remain paused when editing is cancelled. A changed revision requires choosing the message again. Send Immediately moves the original message to the front and stops the current task before running it. Remove All Queued Messages removes the captured revisions and keeps messages added while the action runs.') + '\n' + localize('chat.navigation.help', 'Use {0} to focus the latest response and {1} to return to the last focused message. Use {2} and {3} to move between user prompts without wrapping. Navigation includes loaded messages; load earlier messages to reach older prompts. On macOS, the input-to-list shortcut applies only on the first visual input line. Quick Chat reverses the input-to-list shortcut direction. Use {4} to focus a pending confirmation or return to the input. Focusing never accepts or declines a request, sends a message or changes the draft.', '<keybinding:chat.action.focus>', '<keybinding:workbench.chat.action.focusLastFocused>', '<keybinding:workbench.action.chat.previousUserPrompt>', '<keybinding:workbench.action.chat.nextUserPrompt>', '<keybinding:workbench.action.chat.focusConfirmation>') + '\n' + localize('chat.find.commandsHelp', 'Use {0} to find text in this conversation. Find includes complete code blocks and continues through earlier history without sending or changing the draft. Use the result controls to navigate; Escape closes Find and restores focus.', '<keybinding:workbench.action.chat.find>')
							: session.widget.model.items.map(item => item.text).filter(Boolean).join('\n\n'),
						() => { if (!this.isDisposed && this.session === session) this.open(); }, AccessibilityVerbositySettingId.QuickChat);
					provider.onDidChangeContent = session.widget.model.onDidChange;
					return provider;
				},
			}));
		}
	}

	get enabled(): boolean {
		return this.configuration.getValue<boolean>(ChatAIDisabledSettingId) !== true && this.contexts.getValue(IsSessionsWindowContext.key) !== true;
	}
	get focused(): boolean { return !!this.input && this.root.contains(this.root.ownerDocument.activeElement); }
	get sessionResource() {
		const widget = this.input && this.session?.widget;
		return widget?.sessionId && widget.threadId ? buildOpenSessionLinkUri(widget.sessionId, widget.threadId, 'local') : undefined;
	}

	toggle(options?: IQuickChatOpenOptions): void {
		if (this.focused && !options?.query) this.close();
		else this.open(options);
	}

	open(options?: IQuickChatOpenOptions): void {
		if (!this.enabled || this.isDisposed) return;
		const request = ++this.opening;
		void this.show(options, request).catch(error => { if (!this.isDisposed) this.report(error); });
	}

	private async show(options: IQuickChatOpenOptions | undefined, request: number): Promise<void> {
		if (!this.session) {
			const wasVisible = this.views.isViewVisible(CHAT_VIEW_ID);
			const view = this.views.getViewWithId<ChatViewPane>(CHAT_VIEW_ID) ?? await this.views.openView<ChatViewPane>(CHAT_VIEW_ID, false);
			if (!wasVisible) this.views.closeView(CHAT_VIEW_ID);
			if (request !== this.opening || this.isDisposed || !this.enabled) return;
			if (!(view instanceof ChatViewPane)) throw new Error(localize('quickChat.unavailable', 'Quick Chat is unavailable in this window.'));
			this.session = view.createQuickChat(this.content, this.titleId);
			const lifetime = new DisposableStore();
			this.retiredSession.value = lifetime;
			lifetime.add(this.session.widget.model.onDidChange(() => this.updateLayout()));
			lifetime.add(this.session.onDidDispose(() => {
				this.close();
				this.session = undefined;
				this.retiredSession.clear();
			}));
		}
		const session = this.session;
		if (!this.input) {
			const input = this.quickInput.createQuickWidget();
			input.widget = this.root;
			input.ignoreFocusOut = true;
			input.contextKey = 'chatInputVisible';
			this.input = input;
			const listener = input.onDidHide(() => {
				if (this.input !== input) return;
				this.input = undefined;
				if (!this.movingToView) session.setVisible(false);
				const editor = session.widget.inputEditor;
				if (this.partialQuery !== undefined && editor?.getModel()?.getValue() === this.partialQuery) editor.getModel()?.setValue('');
				this.partialQuery = undefined;
				listener.dispose();
				input.dispose();
				this.closed.fire();
			});
			input.show();
		}
		session.setVisible(true);
		this.updateLayout();
		session.widget.focus();
		if (options?.query) {
			const editor = session.widget.inputEditor;
			editor?.getModel()?.setValue(options.query);
			if (options.selection) editor?.setSelection(options.selection);
			this.partialQuery = options.isPartialQuery ? options.query : undefined;
			if (!options.isPartialQuery && options.query.trim()) {
				// A cold composer must finish model loading before the input can admit a send.
				await session.widget.model.prepareConversation?.();
				if (request !== this.opening || this.session !== session || !this.input || !this.enabled || this.isDisposed) return;
				if (editor && editor.getModel()?.getValue() !== options.query) return;
				await session.widget.acceptInput(editor ? undefined : options.query);
			}
		}
	}

	focus(): void { if (this.input) this.session?.widget.focus(); }
	close(): void { ++this.opening; this.input?.hide(); }

	async openInChatView(): Promise<void> {
		const session = this.session;
		if (!session) return;
		// Reparent the original editor; no response replay or second model is involved.
		this.partialQuery = undefined;
		this.movingToView = true;
		try { this.close(); }
		finally { this.movingToView = false; }
		this.retiredSession.clear();
		this.session = undefined;
		session.reveal();
		await this.views.focusView(CHAT_VIEW_ID);
	}

	private report(error: unknown): void {
		this.notifications.error(localize('quickChat.failed', 'Could not open Quick Chat: {0}', String(error)));
	}

	private updateLayout(): void {
		const maximum = Math.max(0, this.layout.activeContainerDimension.height - 80);
		const minimum = Math.min(280, maximum);
		// Start compact, then make room for answers unless the user chose a height.
		const desired = this.preferredHeight ?? (this.session?.widget.model.items.length ? 560 : 280);
		const height = clamp(desired, minimum, maximum);
		this.root.style.height = `${height}px`;
		this.resizeSash.element.setAttribute('aria-valuemin', String(minimum));
		this.resizeSash.element.setAttribute('aria-valuemax', String(maximum));
		this.resizeSash.element.setAttribute('aria-valuenow', String(height));
		this.resizeSash.layout();
	}

	protected override disposeCore(): void {
		this.close();
		this.retiredSession.clear();
		this.session?.dispose();
		this.session = undefined;
		this.root.remove();
		super.disposeCore();
	}
}
