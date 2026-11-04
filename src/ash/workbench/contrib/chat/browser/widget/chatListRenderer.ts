import { ChatErrorContentPart } from './chatContentParts/chatErrorContentPart.js';
import { parseInlineFileReference } from '../../common/widget/annotations.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import type { ChatLayoutTrace } from './chatLayoutTrace.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { ICommandService, CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { HasSpeechProvider, TextToSpeechInProgress } from '../../../speech/common/speechService.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { ChatInputEditors, type ChatInputEditorOptions, type IChatInputEditor } from './input/chatInputEditorRegistry.js';
import { installChatInputLayout } from './input/chatInputLayout.js';
import { ChatResourceGroupWidget } from './chatContentParts/chatResourceGroupWidget.js';
import { DefaultChatAttachmentWidget } from '../attachments/chatAttachmentWidgets.js';
import { URI } from '../../../../../base/common/uri.js';
import { ChatAttachmentsContentPart } from './chatContentParts/chatAttachmentsContentPart.js';
import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import type { ChatTurnErrorAction, IChatListItem } from '../../common/model/chatViewModel.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { OPEN_SESSION_LINK_SCHEME } from '../../../../../platform/agentHost/common/openSessionLink.js';
import { ChatMarkdownContentPart } from './chatContentParts/chatMarkdownContentPart.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ChatToolInvocationPart } from './chatContentParts/toolInvocationParts/chatToolInvocationPart.js';
import type { IChatContentPart } from './chatContentParts/chatContentParts.js';
import type { IChatMcpAppDelegate } from './chatContentParts/toolInvocationParts/chatMcpAppModel.js';
import { createUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { ChatAccessibilityProvider } from '../accessibility/chatAccessibilityProvider.js';
import { ChatHookContentPart } from './chatContentParts/chatHookContentPart.js';
import { ChatThinkingContentPart } from './chatContentParts/chatThinkingContentPart.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { IsSessionsWindowContext } from '../../../../common/contextkeys.js';
import { captureAnimationTarget, triggerClickAnimation, ClickAnimation } from '../../../../../base/browser/ui/animations/animations.js';
import { ChatResponseFeedbackStoragePrefix, ChatUpvoteAnimationSettingId, isResponseHelpful, type ChatUpvoteAnimation } from '../../common/chatResponseFeedback.js';
import { MarkHelpfulActionId } from '../actions/chatTitleActions.js';

import type { IChatInputPart } from './input/chatInputPart.js';
import type { ResolvedChatContext } from '../../../../services/chat/common/chatContextService.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';

export interface ChatRequestInputOptions {
	readonly container: HTMLElement;
	readonly descriptionId: string;
	readonly submit: (text: string, contexts: readonly ResolvedChatContext[]) => Promise<void>;
	readonly reportError: (error: unknown) => void;
}

interface ChatListItemRendererOptions {
	readonly classPrefix: string;
	readonly createRequestInput?: (options: ChatRequestInputOptions) => IChatInputPart;
	readonly createRequestEditor?: (options: ChatInputEditorOptions) => IChatInputEditor;
	readonly deferCodeBlockModels: boolean;
	readonly isVisible: () => boolean;
	/** Borrowed view state remains owned by the list across row replacements. */
	readonly advisorExpansion: Map<string, boolean>;
	readonly contextExpansion: Map<string, boolean>;
	readonly thinkingExpansion: Map<string, boolean>;
	readonly onDidChangeHeight: () => void;
	readonly onDidChangeMarkdownHeight: (id: string) => void;
	readonly onDidChangeContent: () => void;
	readonly mcpAppDelegate?: IChatMcpAppDelegate;
	readonly onDidRequestMemoryReference?: (reference: string) => void;
	readonly onDidRequestErrorAction?: (action: ChatTurnErrorAction) => void;
	readonly onDidRequestLink?: (target: string) => void;
	readonly imageResourceLoader?: (resource: URI) => Promise<Blob>;
}

const speechContextKeys = new Set([HasSpeechProvider.key, TextToSpeechInProgress.key]);

/** Owns one message's DOM, incremental content, actions and disposable resources. */
export class ChatListItemRenderer extends Disposable {
	public getFileTreeInfos() { return this.toolPart?.getFileTreeInfos() ?? this.resources.value?.getFileTreeInfos() ?? []; }
	public getLastFocusedFileTree() { return this.toolPart?.getLastFocusedFileTree() ?? this.resources.value?.getLastFocusedFileTree(); }
	inViewport = true;
	private readonly edit = this._register(new MutableDisposable<DisposableStore>());
	private copyButton: Button | undefined;
	private updateReadAloud: (() => void) | undefined;
	private updateHelpful: (() => void) | undefined;
	private readonly reading = this._register(new MutableDisposable<IDisposable & { readonly source: CancellationTokenSource; readonly item: IChatListItem; }>());
	private readonly memoryReferences = this._register(new DisposableMap<string, IDisposable & { readonly element: HTMLButtonElement; }>());
	private readonly media = this._register(new MutableDisposable<ChatAttachmentsContentPart>());
	private readonly mediaChanges = this._register(new MutableDisposable());
	private readonly resources = this._register(new MutableDisposable<ChatResourceGroupWidget>());
	private readonly resourceChanges = this._register(new MutableDisposable());
	public readonly element: HTMLElement;
	public toolPart: ChatToolInvocationPart | undefined;
	public markdownPart: ChatMarkdownContentPart | undefined;
	public thinkingPart: ChatThinkingContentPart | undefined;
	public context: { readonly disclosure: HTMLDetailsElement; readonly summary: HTMLElement; readonly content: HTMLElement; } | undefined;
	private attachments: HTMLElement | undefined;
	private hookPart: ChatHookContentPart | undefined;
	private readonly accessibilityProvider = new ChatAccessibilityProvider();

	constructor(
		public item: IChatListItem,
		ownerDocument: Document,
		private readonly options: ChatListItemRendererOptions,
		private readonly layoutTrace: ChatLayoutTrace,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commands: ICommandService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this.element = h(ownerDocument, 'article');
		this.renderItem(item);
		this.refreshContent();
		this.layoutTrace.trace('renderElement', () => `create type=${item.type} chars=${item.text.length} transient=${item.transient}`);
		if (this.updateHelpful) {
			this._register(this.storageService.onDidChangeValue(event => {
				if (event.scope === StorageScope.PROFILE && event.key.startsWith(ChatResponseFeedbackStoragePrefix)) {
					this.updateHelpful?.();
				}
			}));
		}
	}

	/** The list replaces the row only when its existing content cannot consume the new item. */
	public update(item: IChatListItem): 'unchanged' | 'updated' | 'replace' {
		this.layoutTrace.trace('renderElement', () => `update type=${item.type} chars=${item.text.length} transient=${item.transient}`);
		const contentPart: IChatContentPart | undefined = this.toolPart ?? this.markdownPart;
		if (sameItem(this.item, item) && this.item.content === item.content && (!contentPart || contentPart.hasSameContent(item))) {
			this.item = item;
			return 'unchanged';
		}
		if (this.context && item.type === 'userContext' && item.contextText !== undefined
			&& item.contextSourceUrl === this.item.contextSourceUrl && (!item.contextSourceUrl || item.text === this.item.text)) {
			if (!item.contextSourceUrl) this.context.summary.textContent = item.text;
			this.context.content.setAttribute('aria-label', item.text);
			if (this.item.contextText !== item.contextText) this.context.content.textContent = item.contextText;
			this.item = item;
		} else if (this.hookPart && item.hookPart && this.item.hookPart?.run.runId === item.hookPart.run.runId) {
			this.hookPart.render(item.hookPart);
			this.item = item;
			this.updateState();
		} else if (this.toolPart && item.toolInvocation && this.toolPart.toolCallId === item.toolInvocation.call.toolCallId
			&& this.item.toolInvocation?.call.turnId === item.toolInvocation.call.turnId) {
			this.toolPart.render(item.toolInvocation, item.attachmentSource);
			this.item = item;
			this.updateState();
		} else if (this.thinkingPart && item.type === 'reasoning') {
			this.thinkingPart.updateThinking(item);
			this.item = item;
			this.updateState();
		} else if (this.markdownPart && !sameItem(this.item, item) && this.item.type === item.type && this.item.label === item.label && this.item.detail === item.detail && sameAction(this.item.action, item.action)
			&& (this.item.text === item.text && this.item.transient === item.transient
				|| this.markdownPart.tryIncrementalUpdate({ value: item.text, supportThemeIcons: true, supportAlertSyntax: true }, item.transient))) {
			this.item = item;
			this.updateState();
		} else if (this.toolPart || !sameItem(this.item, item)) {
			return 'replace';
		}
		this.refreshContent();
		return 'updated';
	}

	private updateState(): void {
		this.element.classList.toggle('error', this.item.isError === true);
		if (this.item.transient) this.element.dataset.transient = 'true';
		else delete this.element.dataset.transient;
	}

	private refreshContent(): void {
		if (this.copyButton) this.copyButton.enabled = this.item.text.length > 0;
		const reading = this.reading.value;
		if (reading && (reading.item.text !== this.item.text || reading.item.attachmentSource?.sessionId !== this.item.attachmentSource?.sessionId || reading.item.attachmentSource?.threadId !== this.item.attachmentSource?.threadId)) this.reading.clear();
		this.updateReadAloud?.();
		this.updateHelpful?.();
		this.renderAttachments();
		this.renderMemoryReferences();
	}

	public setVisible(visible: boolean): void {
		if (!visible) this.reading.clear();
		this.media.value?.setVisible(visible);
		this.toolPart?.setVisible(visible);
		if (this.thinkingPart) {
			this.thinkingPart.setVisible(visible);
		} else {
			this.markdownPart?.setVisible(visible);
		}
	}

	public override dispose(): void {
		if (this.isDisposed) return;
		this.layoutTrace.trace('disposeElement', () => `type=${this.item.type}`);
		this.element.remove();
		super.dispose();
	}

	private renderAttachments(): void {
		if (!this.attachments) return;
		const content = this.item.content ?? [];
		const changed = () => { this.options.onDidChangeHeight(); this.options.onDidChangeContent(); };
		if (content.some(part => part.type !== 'text' && part.type !== 'artifact')) {
			if (!this.media.value) {
				const media = this.instantiationService.createInstance(ChatAttachmentsContentPart, { ownerDocument: this.element.ownerDocument, variables: content, source: this.item.attachmentSource });
				this.media.value = media;
				this.attachments.prepend(media.domNode);
				this.mediaChanges.value = media.onDidChangeHeight(changed);
			} else this.media.value.updateVariables(content, this.item.attachmentSource);
		} else { this.mediaChanges.clear(); this.media.clear(); }
		if (content.some(part => part.type === 'artifact')) {
			if (!this.resources.value) {
				const resources = this.instantiationService.createInstance(ChatResourceGroupWidget, this.element.ownerDocument);
				this.resources.value = resources;
				this.attachments.append(resources.domNode);
				this.resourceChanges.value = resources.onDidChangeHeight(changed);
			}
			this.resources.value.render(content, JSON.stringify([this.item.attachmentSource?.sessionId, this.item.attachmentSource?.threadId, this.item.id]), this.item.attachmentSource);
		} else { this.resourceChanges.clear(); this.resources.clear(); }
	}

	private renderCopyAction(lifetime: DisposableStore): HTMLElement {
		const actions = h(this.element.ownerDocument, 'div');
		actions.className = 'ash-chat-message-actions';
		const button = lifetime.add(new Button(actions, {
			...defaultButtonStyles,
			label: localize('chat.message.copy', 'Copy message'),
			icon: Lxicon.copy,
			presentation: 'quiet',
			size: 'small',
			enabled: this.item.text.length > 0,
		}));
		this.copyButton = button;
		const feedback = h(this.element.ownerDocument, 'span');
		feedback.className = 'ash-chat-message-copy-status';
		feedback.setAttribute('role', 'status');
		actions.append(feedback);
		this.element.append(actions);
		const clear = lifetime.add(new RunOnceScheduler(() => { feedback.textContent = ''; }, 2000));
		let copying = false;
		lifetime.add(button.onDidClick(() => {
			if (copying || this.isDisposed || !this.options.isVisible() || !this.item.text) return;
			const item = this.item;
			const context = { type: item.type, text: item.text };
			copying = true;
			button.domNode.setAttribute('aria-busy', 'true');
			clear.cancel();
			feedback.textContent = '';
			void this.commands.executeCommand('workbench.action.chat.copyItem', context).then(() => {
				if (this.isDisposed || this.item !== item) return;
				feedback.textContent = localize('chat.message.copied', 'Message copied.');
				clear.schedule();
			}, error => {
				if (this.isDisposed || this.item !== item) return;
				feedback.textContent = localize('chat.message.copyFailed', 'Could not copy message: {0}', String(error));
			}).finally(() => { copying = false; if (!this.isDisposed) button.domNode.removeAttribute('aria-busy'); });
		}));
		if (this.item.type === 'agentMessage') {
			this.renderReadAloudAction(actions, lifetime);
			if (!this.contextKeys.getValue<boolean>(IsSessionsWindowContext.key)) this.renderHelpfulAction(actions, lifetime);
		}
		return actions;
	}

	private renderHelpfulAction(actions: HTMLElement, lifetime: DisposableStore): void {
		const button = lifetime.add(new Button(actions, {
			...defaultButtonStyles, label: localize('chat.response.helpful', 'Helpful'),
			title: localize('chat.response.helpfulTooltip', 'Mark this response helpful in Ash'),
			icon: Lxicon.thumbsup, iconOnly: true, presentation: 'quiet', size: 'small', checked: false,
		}));
		button.domNode.classList.add('ash-chat-response-helpful');
		const status = h(actions.ownerDocument, 'span');
		status.setAttribute('role', 'status');
		actions.append(status);
		const feedback = lifetime.add(new MutableDisposable());
		let pending = false;
		const update = (): void => {
			const target = this.item.feedbackSource;
			button.hidden = !target || this.item.transient || this.item.isError === true;
			button.enabled = !pending;
			button.checked = !!target && isResponseHelpful(this.storageService, target);
		};
		this.updateHelpful = update;
		update();
		lifetime.add(button.onDidClick(() => {
			const target = this.item.feedbackSource;
			if (!target || pending || this.isDisposed || !this.options.isVisible()) return;
			const captured = captureAnimationTarget(button.domNode);
			pending = true;
			status.textContent = '';
			update();
			void this.commands.executeCommand<boolean>(MarkHelpfulActionId, target).then(changed => {
				if (this.isDisposed || this.item.feedbackSource !== target || !changed) return;
				status.textContent = localize('chat.response.helpfulSaved', 'Marked helpful in Ash.');
				const kind = this.configurationService.getValue<ChatUpvoteAnimation>(ChatUpvoteAnimationSettingId) ?? 'floatingThumbs';
				const animation = { confetti: ClickAnimation.Confetti, floatingThumbs: ClickAnimation.FloatingIcons, pulseWave: ClickAnimation.PulseWave, radiantLines: ClickAnimation.RadiantLines };
				if (kind !== 'off') feedback.value = triggerClickAnimation(captured, animation[kind], Lxicon.thumbsup);
			}, error => {
				if (!this.isDisposed) status.textContent = localize('chat.response.helpfulFailed', 'Could not save feedback in Ash: {0}', String(error));
			}).finally(() => { pending = false; if (!this.isDisposed) update(); });
		}));
	}

	private renderEditAction(requestText: HTMLElement, lifetime: DisposableStore, actions?: HTMLElement): void {
		const edit = actions ? lifetime.add(new Button(actions, {
			...defaultButtonStyles, label: localize('chat.edit.label', 'Edit message'), presentation: 'quiet', size: 'small',
		})) : undefined;
		const editTarget = edit?.domNode ?? requestText;
		requestText.classList.add('ash-chat-request-editable');
		const open = (): void => {
			if (this.edit.value || !this.item.requestSource || !this.options.isVisible()) return;
			const source = this.item.requestSource;
			const store = new DisposableStore();
			this.edit.value = store;
			const editor = h(this.element.ownerDocument, 'div');
			editor.className = 'ash-chat-request-editor';
			const editorHost = h(editor.ownerDocument, 'div');
			editorHost.className = 'ash-chat-input-editor-host';
			const explanation = h(editor.ownerDocument, 'span');
			explanation.id = createUuid();
			explanation.hidden = true;
			explanation.textContent = localize('chat.edit.description', 'Sending creates a new chat from before this request. Its context and attachments are kept; the original chat and draft stay available.');
			const feedback = h(editor.ownerDocument, 'div');
			feedback.setAttribute('role', 'status');
			editor.append(explanation, feedback);
			requestText.before(editor);
			requestText.hidden = true;
			if (actions) actions.hidden = true;
			store.add(toDisposable(() => {
				editor.remove();
				requestText.hidden = false;
				if (actions) actions.hidden = false;
			}));
			const close = (restoreFocus = true): void => {
				const returnToEdit = restoreFocus && this.options.isVisible() && editor.contains(editor.ownerDocument.activeElement);
				this.edit.clear();
				if (returnToEdit) editTarget.focus();
				this.options.onDidChangeHeight();
				this.options.onDidChangeContent();
			};
			let pending = false;
			let attempt: { signature: string; commandId: string; } | undefined;
			const reportError = (error: unknown): void => {
				if (this.edit.value === store) feedback.textContent = localize('chat.edit.failed', 'Could not send the edited request: {0}', String(error));
			};
			const submit = async (text: string, contexts: readonly ResolvedChatContext[] = []): Promise<void> => {
				if (pending || !text.trim() || this.isDisposed || !this.options.isVisible()) return;
				const signature = JSON.stringify([text, contexts]);
				if (attempt?.signature !== signature) attempt = { signature, commandId: createUuid() };
				pending = true;
				editor.setAttribute('aria-busy', 'true');
				feedback.textContent = '';
				try {
					await this.commands.executeCommand('workbench.action.chat.resendRequest', { ...source, text, commandId: attempt.commandId, contexts });
					if (this.edit.value === store) close();
				} finally {
					pending = false;
					if (this.edit.value === store) editor.removeAttribute('aria-busy');
				}
			};
			try {
				if (this.options.createRequestInput) {
					const input = store.add(this.options.createRequestInput({ container: editor, descriptionId: explanation.id, submit, reportError }));
					input.appendToDraft(this.item.text);
					input.focus();
				} else {
					editor.classList.add('ash-chat-input-container');
					const controls = h(editor.ownerDocument, 'div', { className: 'ash-chat-input-toolbars' });
					const send = store.add(new Button(controls, {
						...defaultButtonStyles, label: localize('chat.edit.resend', 'Send edited request'), icon: Lxicon.arrowUp, iconOnly: true,
					}));
					send.domNode.classList.add('ash-chat-input-action', 'ash-chat-input-send-action');
					editor.prepend(editorHost, controls);
					const options: ChatInputEditorOptions = {
						container: editorHost, placeholder: '', ariaLabel: localize('chat.edit.input', 'Edit request'),
						ariaDescribedBy: explanation.id, submitWithModifier: true, height: { minimum: 0 }, tabFocusMode: true,
					};
					const input = store.add(this.options.createRequestEditor?.(options) ?? ChatInputEditors.create(options));
					input.value = this.item.text;
					send.enabled = !!input.value.trim();
					store.add(installChatInputLayout(editor, input, controls));
					const sendEdit = async (): Promise<void> => {
						if (pending || !input.value.trim()) return;
						input.setReadOnly(true);
						send.enabled = false;
						try { await submit(input.value); }
						catch (error) { reportError(error); }
						finally {
							if (this.edit.value === store) {
								input.setReadOnly(false);
								send.enabled = !!input.value.trim();
								const active = editor.ownerDocument.activeElement;
								if (this.options.isVisible() && (editor.contains(active) || active === editor.ownerDocument.body)) input.focus();
							}
						}
					};
					store.add(send.onDidClick(() => void sendEdit()));
					store.add(input.onDidChange(() => { send.enabled = !!input.value.trim() && !pending; }));
					store.add(input.onDidSubmit(() => void sendEdit()));
					input.layout();
					input.focus();
					input.setSelection({ anchor: input.value.length, active: input.value.length });
				}
			} catch (error) {
				this.edit.clear();
				throw error;
			}
			// Wait until the outside click finishes so collapsing the editor does not move its target.
			const quickInput = this.instantiationService.getOptional(IQuickInputService);
			const dismiss = store.add(new RunOnceScheduler(() => { if (!pending) close(false); }, 0));
			let pressedInside = false;
			store.add(addDisposableListener(editor.ownerDocument, 'pointerdown', event => {
				pressedInside = event.composedPath().includes(editor) || !!quickInput?.currentQuickInput;
			}, true));
			store.add(addDisposableListener(editor.ownerDocument, 'click', event => {
				if (!pending && event.detail > 0 && !pressedInside && !event.composedPath().includes(editor)) dismiss.schedule();
			}, true));
			store.add(addDisposableListener(editor, 'keydown', event => {
				if (event.isComposing) return;
				if (event.key === 'Escape' && !pending) { event.preventDefault(); event.stopPropagation(); close(); }
			}));
			this.options.onDidChangeHeight(); this.options.onDidChangeContent();
		};
		if (edit) {
			lifetime.add(edit.onDidClick(open));
		} else {
			requestText.tabIndex = 0;
			requestText.setAttribute('role', 'button');
			requestText.setAttribute('aria-description', localize('chat.edit.label', 'Edit message'));
			lifetime.add(addDisposableListener(requestText, 'keydown', event => {
				if (event.isComposing || (event.key !== 'Enter' && event.key !== ' ')) return;
				event.preventDefault();
				event.stopPropagation();
				if (!event.repeat) open();
			}));
		}
		lifetime.add(addDisposableListener(requestText, 'click', event => {
			// Keep drag-to-select available on the message text.
			const selection = requestText.ownerDocument.getSelection();
			if (event.button === 0 && (!selection || selection.isCollapsed)) open();
		}));
	}

	private renderReadAloudAction(actions: HTMLElement, lifetime: DisposableStore): void {
		const button = lifetime.add(new Button(actions, {
			...defaultButtonStyles,
			label: localize('chat.message.readAloud', 'Read aloud'),
			presentation: 'quiet',
			size: 'small',
		}));
		const feedback = h(actions.ownerDocument, 'span');
		feedback.className = 'ash-chat-message-read-status';
		feedback.setAttribute('role', 'status');
		actions.append(feedback);
		const update = () => {
			if (this.isDisposed) return;
			const context = this.contextKeys.getContext();
			button.domNode.hidden = !CommandsRegistry.hasCommand('workbench.action.chat.readChatResponseAloud') || context.getValue(HasSpeechProvider.key) !== true;
			const reading = !!this.reading.value;
			button.label = reading ? localize('chat.message.stopReadAloud', 'Stop reading aloud') : localize('chat.message.readAloud', 'Read aloud');
			button.enabled = reading || !this.item.transient && !!this.item.text && context.getValue(TextToSpeechInProgress.key) !== true;
			button.domNode.setAttribute('aria-pressed', String(reading));
		};
		this.updateReadAloud = update;
		lifetime.add(this.contextKeys.onDidChangeContext(event => { if (event.affectsSome(speechContextKeys)) update(); }));
		lifetime.add(CommandsRegistry.onDidChangeCommands(update));
		lifetime.add(addDisposableListener(this.element, 'keydown', event => {
			if ((event as KeyboardEvent).key !== 'Escape' || !this.reading.value) return;
			this.reading.clear(); update(); event.preventDefault(); event.stopPropagation();
		}));
		lifetime.add(button.onDidClick(() => {
			if (this.isDisposed || !this.options.isVisible()) return;
			const current = this.reading.value;
			if (current) {
				void this.commands.executeCommand('workbench.action.chat.stopReadChatItemAloud', { source: current.source });
				return;
			}
			const item = this.item;
			const source = new CancellationTokenSource();
			const operation = Object.assign(toDisposable(() => source.dispose(true)), { source, item });
			this.reading.value = operation; feedback.textContent = ''; update();
			void this.commands.executeCommand('workbench.action.chat.readChatResponseAloud', { type: item.type, text: item.text, source }).catch(error => {
				if (!this.isDisposed && this.reading.value === operation && !source.token.isCancellationRequested && !isCancellationError(error)) {
					feedback.textContent = localize('chat.message.readAloudFailed', 'Could not read response aloud: {0}', String(error));
				}
			}).finally(() => {
				if (this.reading.value === operation) this.reading.clear();
				update();
			});
		}));
		update();
	}

	private renderMemoryReferences(): void {
		if (!this.options.onDidRequestMemoryReference) return;
		const references = [...new Set(this.item.text.match(/memory:[A-Za-z0-9_-]+/g) ?? [])].filter(reference => reference.length <= 4096).slice(0, 8);
		for (const [reference] of this.memoryReferences) {
			if (!references.includes(reference)) this.memoryReferences.deleteAndDispose(reference);
		}
		for (const [index, reference] of references.entries()) {
			let rendered = this.memoryReferences.get(reference);
			if (!rendered) {
				const button = h(this.element.ownerDocument, 'button');
				button.type = 'button';
				const click = addDisposableListener(button, 'click', () => this.options.onDidRequestMemoryReference?.(reference));
				rendered = this.memoryReferences.set(reference, Object.assign(toDisposable(() => { click.dispose(); button.remove(); }), { element: button }));
				this.element.append(button);
			}
			rendered.element.textContent = localize('chat.transcript.memoryReference', 'Open memory reference {0}', index + 1);
		}
	}

	private renderItem(item: IChatListItem): void {
		const disposables = this._register(new DisposableStore());
		const article = this.element;
		article.className = `${this.options.classPrefix}-item ${this.options.classPrefix}-item-${item.type}`;
		// Accessible View can restore focus to the message without adding a Tab stop.
		article.tabIndex = -1;
		article.dataset.itemId = item.id;
		article.tabIndex = -1;
		if (item.transient) article.dataset.transient = 'true';
		if (item.isError) article.classList.add('error');
		if (item.toolInvocation) {
			const part = disposables.add(this.instantiationService.createInstance(ChatToolInvocationPart, article.ownerDocument, item.toolInvocation, item.attachmentSource, this.options.mcpAppDelegate));
			disposables.add(part.onDidChangeHeight(() => { this.options.onDidChangeHeight(); this.options.onDidChangeContent(); }));
			article.append(part.domNode);
			this.toolPart = part;
			return;
		}
		if (item.type === 'hook' && item.hookPart) {
			const part = disposables.add(new ChatHookContentPart(article.ownerDocument, item.hookPart));
			article.append(part.domNode);
			this.hookPart = part;
			return;
		}
		if (item.type === 'userContext' && item.contextText !== undefined) {
			const label = h(article.ownerDocument, 'div');
			label.className = `${this.options.classPrefix}-item-label`;
			label.textContent = this.accessibilityProvider.getAriaLabel(item);
			if (item.contextSourceUrl?.startsWith('https://')) {
				const source = URI.parse(item.contextSourceUrl);
				disposables.add(this.instantiationService.createInstance(DefaultChatAttachmentWidget, {
					id: item.id, kind: 'transcriptContext', name: item.text, resource: source,
					resolve: async () => ({ name: item.text, content: item.contextText! }),
				}, { supportsDeletion: false, shouldFocusClearButton: false }, article));
			}
			const disclosure = h(article.ownerDocument, 'details');
			disclosure.className = 'ash-chat-context';
			const summary = h(article.ownerDocument, 'summary');
			summary.textContent = item.contextSourceUrl ? localize('chat.context.viewSnapshot', 'View attachment snapshot') : item.text;
			const content = h(article.ownerDocument, 'pre');
			content.textContent = item.contextText;
			content.tabIndex = 0;
			content.setAttribute('aria-label', item.text);
			disclosure.open = this.options.contextExpansion.get(item.id) ?? false;
			disclosure.append(summary, content);
			article.append(label, disclosure);
			disposables.add(addDisposableListener(disclosure, 'toggle', () => {
				this.options.contextExpansion.set(item.id, disclosure.open);
				this.options.onDidChangeHeight();
			}));
			this.context = { disclosure, summary, content };
			return;
		}
		const body = item.type === 'advisor' ? h(this.element.ownerDocument, 'details') : article;
		if (item.type === 'userMessage' || item.type === 'agentMessage') {
			if (item.type === 'userMessage') article.classList.add('ash-chat-user-message');
			article.setAttribute('aria-label', this.accessibilityProvider.getAriaLabel(item));
		} else if (item.type !== 'reasoning') {
			const label = h(article.ownerDocument, item.type === 'advisor' ? 'summary' : 'div');
			label.className = `${this.options.classPrefix}-item-label`;
			label.textContent = this.accessibilityProvider.getAriaLabel(item);
			body.append(label);
		}
		if (body !== article) {
			const disclosure = body as HTMLDetailsElement;
			disclosure.open = this.options.advisorExpansion.get(item.id) ?? true;
			disposables.add(addDisposableListener(disclosure, 'toggle', () => { this.options.advisorExpansion.set(item.id, disclosure.open); }));
			article.append(body);
		}
		let markdownPart: ChatMarkdownContentPart | undefined;
		let requestText: HTMLElement | undefined;
		if (item.type === 'agentMessage' || item.type === 'reasoning' || item.type === 'plan' || item.type === 'advisor') {
			const markdown = disposables.add(this.instantiationService.createInstance(ChatMarkdownContentPart, {
				ownerDocument: this.element.ownerDocument,
				getChatItem: () => this.item,
				visible: this.options.isVisible() && (item.type !== 'reasoning' || this.options.thinkingExpansion.get(item.id) === true),
				deferCodeBlockModels: this.options.deferCodeBlockModels,
				markdown: { value: item.text, supportThemeIcons: true, supportAlertSyntax: true },
				markedOptions: { breaks: true },
				fillInIncompleteTokens: item.transient,
				actionHandler: this.options.onDidRequestLink ? (target: string) => this.options.onDidRequestLink!(target) : undefined,
				sanitizerConfig: {
					allowedLinkSchemes: { augment: [OPEN_SESSION_LINK_SCHEME] },
					resolveFileLink: item.type === 'agentMessage' && this.options.onDidRequestLink
						? (href: string) => parseInlineFileReference(href) ? href : undefined
						: undefined,
				},
				imageResourceLoader: this.options.imageResourceLoader,
			}));
			disposables.add(markdown.onDidChangeHeight(() => {
				this.options.onDidChangeHeight();
				this.options.onDidChangeMarkdownHeight(item.id);
				this.options.onDidChangeContent();
			}));
			markdownPart = markdown;
			if (item.type === 'reasoning') {
				const thinking = disposables.add(new ChatThinkingContentPart(article.ownerDocument, markdown, {
					expanded: this.options.thinkingExpansion.get(item.id) ?? false,
					visible: this.options.isVisible(),
				}));
				thinking.updateThinking(item);
				disposables.add(thinking.onDidChangeHeight(() => {
					this.options.thinkingExpansion.set(item.id, thinking.domNode.open);
					this.options.onDidChangeHeight();
					this.options.onDidChangeContent();
				}));
				this.thinkingPart = thinking;
				body.append(thinking.domNode);
			} else {
				body.append(markdown.domNode);
			}
		} else {
			const content = h(this.element.ownerDocument, 'pre');
			content.textContent = item.text;
			body.append(content);
			if (item.type === 'userMessage') requestText = content;
		}
		const attachments = h(article.ownerDocument, 'div');
		body.append(attachments);
		if (item.type === 'turnError') {
			disposables.add(new ChatErrorContentPart(article, item, this.options.classPrefix, this.options.onDidRequestErrorAction));
		} else if (item.detail) {
			const detail = h(article.ownerDocument, 'p');
			detail.className = `${this.options.classPrefix}-turn-error-detail`;
			detail.textContent = item.detail;
			body.append(detail);
		}
		this.markdownPart = markdownPart;
		this.attachments = attachments;
		if (item.type === 'agentMessage') {
			this.renderCopyAction(disposables);
		} else if (requestText) {
			const actions = this.contextKeys.getValue<boolean>(IsSessionsWindowContext.key) ? undefined : this.renderCopyAction(disposables);
			if (item.requestSource) this.renderEditAction(requestText, disposables, actions);
		}
	}
}

function sameItem(left: IChatListItem, right: IChatListItem): boolean {
	return left.id === right.id && left.type === right.type && left.text === right.text && left.contextText === right.contextText && left.contextSourceUrl === right.contextSourceUrl
		&& left.requestSource?.sessionId === right.requestSource?.sessionId && left.requestSource?.threadId === right.requestSource?.threadId
		&& left.requestSource?.turnId === right.requestSource?.turnId && left.requestSource?.itemId === right.requestSource?.itemId
		&& left.hookPart?.run === right.hookPart?.run
		&& left.transient === right.transient && left.isError === right.isError
		&& left.label === right.label && left.detail === right.detail && left.errorCode === right.errorCode
		&& sameContent(left.content, right.content) && left.attachmentSource?.sessionId === right.attachmentSource?.sessionId
		&& left.attachmentSource?.threadId === right.attachmentSource?.threadId
		&& left.attachmentSource?.itemId === right.attachmentSource?.itemId
		&& left.attachmentSource?.kind === right.attachmentSource?.kind
		&& sameAction(left.action, right.action);
}

function sameAction(left: ChatTurnErrorAction | undefined, right: ChatTurnErrorAction | undefined): boolean {
	if (left === right) return true;
	if (!left || !right || left.type !== right.type || left.label !== right.label) return false;
	return left.type !== 'retry' || (right.type === 'retry' && left.turnId === right.turnId);
}



function sameContent(left: IChatListItem['content'], right: IChatListItem['content']): boolean {
	if (left === right) return true;
	if (!left || !right || left.length !== right.length) return false;
	return left.every((part, index) => {
		const next = right[index];
		if (part.type !== next.type) return false;
		if (part.type === 'artifact') {
			return next.type === 'artifact'
				&& part.artifact.contentDigest === next.artifact.contentDigest
				&& part.artifact.mimeType === next.artifact.mimeType
				&& part.artifact.data.type === next.artifact.data.type
				&& part.artifact.truncated === next.artifact.truncated
				&& JSON.stringify(part.artifact.source) === JSON.stringify(next.artifact.source);
		}
		if (part.type === 'text') return next.type === 'text' && part.text === next.text;
		if ('url' in part) return 'url' in next && part.url === next.url;
		return 'attachment' in next && part.attachment.contentDigest === next.attachment.contentDigest;
	});
}
