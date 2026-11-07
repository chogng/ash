import { localize, localize2 } from '../../../../../nls.js';
import { h } from '../../../../../base/browser/dom.js';
import { ButtonActionViewItem } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Disposable, toDisposable, type DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { IActionViewItemService } from '../../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, MenuItemAction, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { IAppServerApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import { buildOpenSessionLinkUri } from '../../../../../platform/agentHost/common/openSessionLink.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import type { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IChatService, type ThreadRead } from '../../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService, withChatConversation } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { getCompletedChatResponseSource, type IChatListItem } from '../../common/model/chatViewModel.js';
import { ChatResponseActionContext, IChatWidgetService, unwrapChatResponseActionContext } from '../chat.js';
import { toPortableMarkdown } from '../widget/chatClipboard.js';

// Single-host owners retain the established local address namespace.
const connectionAuthority = 'local';
const CopyItemActionId = 'workbench.action.chat.copyItem';

class ChatCopyFeedback extends Disposable {
	readonly status: HTMLElement;
	private readonly clear = this._register(new RunOnceScheduler(() => this.reset(), 1200));
	private copying = false;

	constructor(private readonly button: Button, container: HTMLElement, private readonly tooltip: string) {
		super();
		this.status = h(container.ownerDocument, 'span', { className: 'ash-chat-message-copy-status', attributes: { role: 'status' } });
		container.append(this.status);
		this._register(toDisposable(() => this.status.remove()));
	}

	private reset(): void {
		this.button.icon = Lxicon.copy;
		this.button.setTitle(this.tooltip);
		this.status.textContent = '';
	}

	async copy(run: () => unknown, isCurrent: () => boolean): Promise<void> {
		if (this.copying || !isCurrent()) return;
		this.copying = true;
		this.button.domNode.setAttribute('aria-busy', 'true');
		this.clear.cancel();
		this.reset();
		try {
			await run();
			if (this.isDisposed || !isCurrent()) return;
			const copied = localize('chat.message.copied', 'Message copied.');
			this.button.icon = Lxicon.check;
			this.button.setTitle(copied);
			this.status.textContent = copied;
			this.clear.schedule();
		} catch (error) {
			if (!this.isDisposed && isCurrent()) this.status.textContent = localize('chat.message.copyFailed', 'Could not copy message: {0}', String(error));
		} finally {
			this.copying = false;
			this.button.domNode.removeAttribute('aria-busy');
		}
	}
}

class ChatCopyActionViewItem extends ButtonActionViewItem {
	private feedback: ChatCopyFeedback | undefined;

	override render(container: HTMLElement): void {
		super.render(container);
		const row = this.actionContext;
		this.feedback = this._register(new ChatCopyFeedback(this.button, row instanceof ChatResponseActionContext ? row.actions : container, this.action.tooltip));
	}

	override setActionContext(context: unknown): void {
		super.setActionContext(context);
		if (this.feedback && context instanceof ChatResponseActionContext && this.feedback.status.parentElement !== context.actions) {
			context.actions.append(this.feedback.status);
		}
	}

	protected override async runAction(): Promise<void> {
		const row = this.actionContext;
		if (!(row instanceof ChatResponseActionContext) || !row.visible) return;
		const item = row.item;
		await this.feedback?.copy(() => this.action.run(item), () => row.visible && row.item === item && !!item.text);
	}
}

export class ChatCopyActionRendering extends Disposable {
	static readonly ID = 'chat.copyActionRendering';

	constructor(@IActionViewItemService presentations: IActionViewItemService) {
		super();
		this._register(presentations.register(MenuId.ChatMessageFooter, CopyItemActionId, (action, options) =>
			action instanceof MenuItemAction ? new ChatCopyActionViewItem(action, options) : undefined));
	}
}

export function renderChatRequestCopyButton(
	container: HTMLElement, lifetime: DisposableStore, commands: ICommandService, getItem: () => IChatListItem, isVisible: () => boolean,
): Button {
	const label = localize('chat.message.copy', 'Copy message');
	const button = lifetime.add(new Button(container, {
		...defaultButtonStyles, label, title: label, icon: Lxicon.copy, presentation: 'quiet', size: 'small', enabled: !!getItem().text,
	}));
	const feedback = lifetime.add(new ChatCopyFeedback(button, container, label));
	lifetime.add(button.onDidClick(() => {
		const item = getItem();
		void feedback.copy(() => commands.executeCommand(CopyItemActionId, item), () => isVisible() && getItem() === item && !!item.text);
	}));
	return button;
}

export class CopyChatSessionLinkAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.copySessionLink',
			title: localize2('chat.copySessionLink', 'Chat: Copy Conversation Link'),
			shortTitle: localize2('chat.copySessionLink.label', 'Copy Conversation Link'),
			icon: Lxicon.share,
			f1: true,
			menu: [
				{ id: MenuId.ChatTitle, group: '1_cutcopypaste', order: 10 },
				{
					id: MenuId.ChatMessageFooter,
					group: 'navigation',
					order: 11,
					when: ContextKeyExpr.and(ChatContextKeys.enabled.isEqualTo(true), ChatContextKeys.responseHasConversationLink.isEqualTo(true)),
				},
			],
		});
	}

	override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
		context = unwrapChatResponseActionContext(context);
		const navigation = accessor.get(IChatSessionNavigationService);
		const selected = context === undefined ? navigation.getActiveConversation() : getCompletedChatResponseSource(context) ?? context;
		if (!selected || typeof selected !== 'object' || !('sessionId' in selected) || !('threadId' in selected)
			|| typeof selected.sessionId !== 'string' || !selected.sessionId || typeof selected.threadId !== 'string' || !selected.threadId) {
			throw new Error(localize('chat.sessionLink.draft', 'Send a message in this conversation before copying its link.'));
		}
		// Capture the command target before asynchronous reads; later selection changes cannot redirect it.
		const { sessionId, threadId } = selected;
		const clipboard = accessor.get(IClipboardService);
		const accessibility = accessor.get(IAccessibilityService);
		if (navigation.prepareConversationLink) {
			const address = await navigation.prepareConversationLink(sessionId, threadId);
			await clipboard.writeText(buildOpenSessionLinkUri(address.sessionId, address.threadId, address.connectionAuthority).toString());
		} else {
			await withChatConversation(accessor.get(IChatService), accessor.get(IAppServerApi), sessionId, threadId,
				() => clipboard.writeText(buildOpenSessionLinkUri(sessionId, threadId, connectionAuthority).toString()));
		}
		accessibility.status(localize('chat.sessionLink.copied', 'Conversation link copied to clipboard'));
	}
}

export function registerChatCopyActions(): void {
	for (const finalResponse of [false, true]) {
		registerAction2(class CopyAllAction extends Action2 {
			constructor() {
				super({
					id: finalResponse ? 'workbench.action.chat.copyFinalResponse' : 'workbench.action.chat.copyAll',
					title: finalResponse ? localize2('chat.copyFinalResponse', 'Chat: Copy Final Response') : localize2('chat.copyAll', 'Chat: Copy Conversation'),
					precondition: ChatContextKeys.enabled.isEqualTo(true),
					f1: true,
				});
			}

			public override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
				const navigation = accessor.get(IChatSessionNavigationService);
				const widget = accessor.get(IChatWidgetService).lastFocusedWidget;
				const selected = context === undefined ? widget ?? navigation.getActiveConversation() : context;
				if (!selected || typeof selected !== 'object' || !('sessionId' in selected) || !('threadId' in selected)
					|| typeof selected.sessionId !== 'string' || !selected.sessionId || typeof selected.threadId !== 'string' || !selected.threadId) {
					return;
				}
				const { sessionId, threadId } = selected;
				const chat = accessor.get(IChatService);
				const clipboard = accessor.get(IClipboardService);
				const accessibility = accessor.get(IAccessibilityService);
				const copy = async (conversation: ThreadRead): Promise<void> => {
					// Read the owning transcript, including history outside the mounted list.
					const messages: string[] = [];
					for (const entry of conversation.transcript.entries) {
						if (finalResponse && !(entry.type === 'item' && entry.item.type === 'agentMessage' && !entry.transient && (entry.item.phase == null || entry.item.phase === 'final_answer')
							|| entry.type === 'voiceTranscript' && entry.transcript.speaker !== 'user')) { continue; }
						let speaker: string;
						let text: string;
						if (entry.type === 'item' && (entry.item.type === 'userMessage' || entry.item.type === 'agentMessage')) {
							speaker = entry.item.type === 'userMessage' ? localize('chat.copyAll.user', 'User') : localize('chat.copyAll.assistant', 'Assistant');
							text = entry.item.text;
						} else if (entry.type === 'voiceTranscript') {
							speaker = entry.transcript.speaker === 'user' ? localize('chat.copyAll.user', 'User') : localize('chat.copyAll.assistant', 'Assistant');
							text = entry.transcript.text;
						} else {
							continue;
						}
						if (text) {
							if (finalResponse) { messages.splice(0, messages.length, text); }
							else { messages.push(`${speaker}: ${text}`); }
						}
					}
					if (messages.length) {
						await clipboard.writeText(toPortableMarkdown(messages.join('\n\n')));
						accessibility.status(finalResponse ? localize('chat.copyFinalResponse.copied', 'Final response copied to clipboard') : localize('chat.copyAll.copied', 'Conversation copied to clipboard'));
					}
				};
				const connection = navigation.captureConnection?.(sessionId);
				try {
					if (connection) {
						await connection.assertCurrent();
						const conversation = await chat.readThread(sessionId, threadId);
						await connection.assertCurrent();
						await copy(conversation);
					} else {
						const appServer = accessor.get(IAppServerApi);
						await withChatConversation(chat, appServer, sessionId, threadId, copy);
					}
				} finally {
					connection?.dispose();
				}
			}
		});

	}

	registerAction2(class CopyItemAction extends Action2 {
		constructor() {
			super({
				id: CopyItemActionId,
				title: localize2('chat.message.copy', 'Copy message'),
				icon: Lxicon.copy,
				precondition: ChatContextKeys.responseHasText.isEqualTo(true),
				menu: { id: MenuId.ChatMessageFooter, group: 'navigation', order: 1 },
			});
		}
		public override async run(accessor: ServicesAccessor, context: unknown): Promise<void> {
			context = unwrapChatResponseActionContext(context);
			if (!context || typeof context !== 'object' || !('text' in context) || typeof context.text !== 'string' || !('type' in context) || context.type !== 'agentMessage' && context.type !== 'userMessage') return;
			await accessor.get(IClipboardService).writeText(toPortableMarkdown(context.text));
		}
	});
	registerAction2(CopyChatSessionLinkAction);
}
