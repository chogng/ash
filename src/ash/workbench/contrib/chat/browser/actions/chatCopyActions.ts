import { localize, localize2 } from '../../../../../nls.js';
import { getActiveDocument, h } from '../../../../../base/browser/dom.js';
import { ButtonActionViewItem, type ActionViewItemOptions } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import type { Button } from '../../../../../base/browser/ui/button/button.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { IActionViewItemService } from '../../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, MenuItemAction, MenusRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { IAppServerApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import { buildOpenSessionLinkUri } from '../../../../../platform/agentHost/common/openSessionLink.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWebWorkerService } from '../../../../../platform/webWorker/browser/webWorkerService.js';
import { IChatService, type ThreadRead } from '../../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService, withChatConversation } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { getCompletedChatResponseSource, type IChatListItem } from '../../common/model/chatViewModel.js';
import { ChatContextMenuActionContext, ChatMessageActionContext, IChatWidgetService, unwrapChatResponseActionContext } from '../chat.js';
import { renderChatClipboardHtml, toPortableMarkdown } from '../widget/chatClipboard.js';
import { expandChatRichContentForCopy } from '../widget/chatMarkdownRichContent.js';

// Single-host owners retain the established local address namespace.
const connectionAuthority = 'local';
export const CopyItemActionId = 'workbench.action.chat.copyItem';

const copyFeedbackDuration = 1200;

class ChatCopyFeedback extends Disposable {
	readonly status: HTMLElement;
	private readonly clear = this._register(new RunOnceScheduler(() => { this.button.icon = Lxicon.copy; }, copyFeedbackDuration));
	private copying = false;

	constructor(private readonly button: Button, container: HTMLElement, private readonly accessibility: IAccessibilityService) {
		super();
		this.status = h(container.ownerDocument, 'span', { className: 'ash-chat-message-copy-status', attributes: { role: 'status' } });
		container.append(this.status);
		this._register(toDisposable(() => this.status.remove()));
	}

	async copy(run: () => unknown, isCurrent: () => boolean): Promise<void> {
		if (this.copying || !isCurrent()) return;
		this.copying = true;
		this.button.domNode.setAttribute('aria-busy', 'true');
		this.clear.cancel();
		this.button.icon = Lxicon.copy;
		this.status.textContent = '';
		try {
			await run();
			if (this.isDisposed || !isCurrent()) return;
			this.button.icon = Lxicon.check;
			this.clear.schedule();
			this.accessibility.status(localize('chat.message.copied', 'Message copied.'));
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

	constructor(action: MenuItemAction, options: ActionViewItemOptions, @IAccessibilityService private readonly accessibility: IAccessibilityService) {
		super(action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		const row = this.actionContext;
		this.feedback = this._register(new ChatCopyFeedback(this.button, row instanceof ChatMessageActionContext ? row.actions : container, this.accessibility));
	}

	override setActionContext(context: unknown): void {
		super.setActionContext(context);
		if (this.feedback && context instanceof ChatMessageActionContext && this.feedback.status.parentElement !== context.actions) {
			context.actions.append(this.feedback.status);
		}
	}

	protected override async runAction(): Promise<void> {
		const row = this.actionContext;
		if (!(row instanceof ChatMessageActionContext) || !row.visible) return;
		const item = row.item;
		await this.feedback?.copy(() => this.action.run(item), () => row.visible && row.item === item && !!item.text);
	}
}

export class ChatCopyActionRendering extends Disposable {
	static readonly ID = 'chat.copyActionRendering';

	constructor(@IActionViewItemService presentations: IActionViewItemService) {
		super();
		for (const menu of [MenuId.ChatMessageTitle, MenuId.ChatMessageFooter]) {
			this._register(presentations.register(menu, CopyItemActionId, (action, options, instantiation) =>
				action instanceof MenuItemAction ? instantiation.createInstance(ChatCopyActionViewItem, action, options) : undefined));
		}
	}
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
				precondition: ContextKeyExpr.or(ChatContextKeys.requestHasText.isEqualTo(true), ChatContextKeys.responseHasText.isEqualTo(true)),
				menu: [
					{ id: MenuId.ChatMessageTitle, group: 'navigation', order: 1 },
					{ id: MenuId.ChatMessageFooter, group: 'navigation', order: 1 },
				],
			});
		}
		public override async run(accessor: ServicesAccessor, context: unknown): Promise<void> {
			if (context instanceof ChatContextMenuActionContext) {
				const clipboard = accessor.get(IClipboardService);
				const accessibility = accessor.get(IAccessibilityService);
				if (clipboard.writeTextWithHtml) {
					await clipboard.writeTextWithHtml(context.text, Promise.resolve(context.html));
				} else {
					await clipboard.writeText(context.text);
				}
				accessibility.status(localize('chat.selection.copied', 'Selection copied.'));
				return;
			}
			context = unwrapChatResponseActionContext(context);
			if (!context || typeof context !== 'object' || !('text' in context) || typeof context.text !== 'string' || !('type' in context) || context.type !== 'agentMessage' && context.type !== 'userMessage') return;
			const clipboard = accessor.get(IClipboardService);
			if (context.type === 'userMessage') {
				await clipboard.writeText(context.text);
				return;
			}
			const richContent = (context as IChatListItem).markdown?.richContent;
			const text = toPortableMarkdown(expandChatRichContentForCopy(context.text, richContent));
			if (clipboard.writeTextWithHtml && richContent?.parts.some(part => part.kind === 'image')) {
				const html = renderChatClipboardHtml(context.text, richContent, getActiveDocument(), accessor.get(IWebWorkerService));
				await clipboard.writeTextWithHtml(text, html);
			} else {
				await clipboard.writeText(text);
			}
		}
	});
	MenusRegistry.appendMenuItem(MenuId.ChatContext, {
		command: {
			id: CopyItemActionId,
			get title() { return localize2('chat.message.copyTooltip', 'Copy'); },
			icon: Lxicon.copy,
		},
		group: 'navigation',
		order: 1,
	});
	registerAction2(CopyChatSessionLinkAction);
}
