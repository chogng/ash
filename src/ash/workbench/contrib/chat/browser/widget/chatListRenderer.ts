import { ChatErrorContentPart } from './chatContentParts/chatErrorContentPart.js';
import { parseInlineFileReference } from '../../common/widget/annotations.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import type { ChatLayoutTrace } from './chatLayoutTrace.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { ActionBar } from '../../../../../base/browser/ui/actionbar/actionbar.js';
import type { IAction } from '../../../../../base/common/actions.js';
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
import { ChatAttachmentsContentPart, type IChatAttachmentResource } from './chatContentParts/chatAttachmentsContentPart.js';
import { addDisposableListener, getWindow, h } from '../../../../../base/browser/dom.js';
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
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';

export interface ChatRequestInputOptions {
	readonly container: HTMLElement;
	readonly descriptionId: string;
	readonly initialHeight: number;
	readonly submit: (text: string, contexts: readonly ResolvedChatContext[]) => Promise<void>;
	readonly reportError: (error: unknown) => void;
}

/** The conversation model supplies response capabilities and any destination-specific labels. */
export interface ChatResponseActions {
	readonly readAloud: (window: Window & typeof globalThis, signal: AbortSignal) => Promise<void>;
	readonly forkLabel: string;
	readonly fork: () => Promise<void>;
	readonly share: () => Promise<void>;
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
	readonly beginRequestEdit: (close: () => boolean) => IDisposable | undefined;
	readonly onWillChangeRequestEditor: (opening: boolean) => () => void;
	readonly onDidChangeMarkdownHeight: (id: string) => void;
	readonly onDidChangeContent: () => void;
	readonly mcpAppDelegate?: IChatMcpAppDelegate;
	readonly onDidRequestMemoryReference?: (reference: string) => void;
	readonly onDidRequestErrorAction?: (action: ChatTurnErrorAction) => void;
	readonly onDidRequestLink?: (target: string) => void;
	readonly readResponseResource?: (item: IChatListItem, resource: URI, signal: AbortSignal) => Promise<Blob>;
	readonly getResponseLinkOpener?: (item: IChatListItem) => ((target: string) => Promise<void>) | undefined;
	readonly getResponseActions?: (item: IChatListItem) => ChatResponseActions | undefined;
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
	private readonly responsePlayback = this._register(new MutableDisposable());
	private updateResponseActions: (() => void) | undefined;
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
	public context: {
		readonly disclosure: HTMLDetailsElement;
		readonly summary: HTMLElement;
		readonly content: HTMLElement;
		readonly entries: Map<string, { readonly element: HTMLDetailsElement; readonly summary: HTMLElement; readonly text: HTMLElement; }>;
	} | undefined;
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
		if (this.context && (item.type === 'userContext' || item.type === 'toolCall') && (item.contextText !== undefined || item.contextEntries)
			&& item.contextSourceUrl === this.item.contextSourceUrl && (!item.contextSourceUrl || item.text === this.item.text)) {
			this.renderContext(item, this.item.transient && !item.transient);
			this.item = item;
			this.updateState();
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
		} else if (this.markdownPart && !sameItem(this.item, item) && this.item.type === item.type && this.item.markdown?.supportHtml === item.markdown?.supportHtml && this.item.label === item.label && this.item.detail === item.detail && sameAction(this.item.action, item.action)
			&& (this.item.text === item.text && this.item.transient === item.transient
				|| this.markdownPart.tryIncrementalUpdate({ value: item.text, supportHtml: item.markdown?.supportHtml, supportThemeIcons: true, supportAlertSyntax: true }, item.transient))) {
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
		this.updateResponseActions?.();
		this.updateHelpful?.();
		this.renderAttachments();
		this.renderMemoryReferences();
	}

	public setVisible(visible: boolean): void {
		if (!visible) {
			this.reading.clear();
			this.responsePlayback.clear();
			this.updateResponseActions?.();
		}
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
		const resources: IChatAttachmentResource[] = (this.item.resources ?? []).map(resource => ({
			type: 'resource', resource: URI.parse(resource.uri), name: resource.name,
			presentation: resource.kind, mimeType: resource.mimeType, frameOrigin: resource.frameOrigin,
		}));
		const mediaContent = [...content, ...resources];
		if (resources.length || content.some(part => part.type !== 'text' && part.type !== 'artifact')) {
			if (!this.media.value) {
				const media = this.instantiationService.createInstance(ChatAttachmentsContentPart, {
					ownerDocument: this.element.ownerDocument, variables: mediaContent, source: this.item.attachmentSource,
					readResource: resources.length && this.options.readResponseResource ? (resource: URI, signal: AbortSignal) => this.options.readResponseResource!(this.item, resource, signal) : undefined
				});
				this.media.value = media;
				this.attachments.prepend(media.domNode);
				this.mediaChanges.value = media.onDidChangeHeight(changed);
			} else this.media.value.updateVariables(mediaContent, this.item.attachmentSource);
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
			title: localize('chat.message.copy', 'Copy message'),
			icon: Lxicon.copy,
			presentation: 'quiet',
			size: 'small',
			enabled: this.item.text.length > 0,
		}));
		this.copyButton = button;
		const copy = this.createCopyHandler(actions, lifetime, button.domNode);
		lifetime.add(button.onDidClick(() => void copy()));
		this.element.append(actions);
		if (this.item.type === 'agentMessage') {
			this.renderReadAloudAction(actions, lifetime);
			if (!this.contextKeys.getValue<boolean>(IsSessionsWindowContext.key)) this.renderHelpfulAction(actions, lifetime);
		}
		return actions;
	}

	private createCopyHandler(actions: HTMLElement, lifetime: DisposableStore, busyTarget?: HTMLElement): () => Promise<void> {
		const feedback = h(this.element.ownerDocument, 'span');
		feedback.className = 'ash-chat-message-copy-status';
		feedback.setAttribute('role', 'status');
		actions.append(feedback);
		const clear = lifetime.add(new RunOnceScheduler(() => { feedback.textContent = ''; }, 2000));
		let copying = false;
		return async () => {
			if (copying || this.isDisposed || !this.options.isVisible() || !this.item.text) return;
			const item = this.item;
			const context = { type: item.type, text: item.text };
			copying = true;
			busyTarget?.setAttribute('aria-busy', 'true');
			clear.cancel();
			feedback.textContent = '';
			try {
				await this.commands.executeCommand('workbench.action.chat.copyItem', context);
				if (this.isDisposed || this.item !== item) return;
				feedback.textContent = localize('chat.message.copied', 'Message copied.');
				clear.schedule();
			} catch (error) {
				if (this.isDisposed || this.item !== item) return;
				feedback.textContent = localize('chat.message.copyFailed', 'Could not copy message: {0}', String(error));
			} finally {
				copying = false;
				busyTarget?.removeAttribute('aria-busy');
			}
		};
	}

	private renderResponseActionBar(lifetime: DisposableStore): void {
		const actions = h(this.element.ownerDocument, 'div', { className: 'ash-chat-message-actions' });
		this.element.append(actions);
		const bar = lifetime.add(new ActionBar(actions, {
			ariaLabel: localize('chat.message.actions', 'Response actions'),
			actionViewItemOptions: { iconOnly: true, buttonStyles: defaultButtonStyles, buttonPresentation: 'quiet' },
		}));
		const copy = this.createCopyHandler(actions, lifetime);
		const action = (id: string, label: string, icon: IAction['icon'], run: () => unknown): IAction => ({
			id, label, tooltip: label, icon, enabled: true, run: () => {
				if (!this.isDisposed && this.options.isVisible()) return run();
			},
		});
		const copyAction = action('chat.response.copy', localize('chat.message.copy', 'Copy message'), Lxicon.copy, copy);
		const disabledCopy = { ...copyAction, enabled: false };
		const getActions = () => this.options.getResponseActions?.(this.item);
		const read = action('chat.response.readAloud', localize('chat.message.readAloud', 'Read aloud'), Lxicon.unmute, async () => {
			const available = getActions();
			if (!available || this.responsePlayback.value) return;
			const controller = new AbortController();
			const playback = toDisposable(() => controller.abort());
			this.responsePlayback.value = playback;
			update();
			try {
				await available.readAloud(getWindow(this.element), controller.signal);
			} catch (error) {
				if (!controller.signal.aborted && !isCancellationError(error) && !this.isDisposed) {
					this.instantiationService.getOptional(INotificationService)?.error(localize('chat.message.readAloudFailed', 'Could not read response aloud: {0}', String(error)));
				}
			} finally {
				if (this.responsePlayback.value === playback) {
					this.responsePlayback.clear();
					update();
				}
			}
		});
		const stop = action(read.id, localize('chat.message.stopReadAloud', 'Stop reading aloud'), Lxicon.mute, () => {
			this.responsePlayback.clear();
			update();
		});
		let fork: IAction | undefined;
		const share = action('chat.response.share', localize('chat.message.share', 'Share response'), Lxicon.share, () => getActions()?.share());
		const update = (): void => {
			const available = getActions();
			const next = [this.item.text ? copyAction : disabledCopy];
			if (available) {
				if (fork?.label !== available.forkLabel) {
					fork = action('chat.response.fork', available.forkLabel, Lxicon.fork, () => getActions()?.fork());
				}
				next.push(this.responsePlayback.value ? stop : read, fork, share);
			}
			if (next.length !== bar.length() || next.some((entry, index) => bar.getAction(index) !== entry)) bar.setActions(next);
		};
		this.updateResponseActions = update;
		lifetime.add(bar.onDidRun(event => {
			if (event.error && !this.isDisposed) this.instantiationService.getOptional(INotificationService)?.error(String(event.error));
		}));
		lifetime.add(addDisposableListener(this.element, 'keydown', event => {
			if (event.key !== 'Escape' || !this.responsePlayback.value) return;
			this.responsePlayback.clear();
			update();
			event.preventDefault();
			event.stopPropagation();
		}));
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
			const close = (restoreFocus = true): void => {
				const returnToEdit = restoreFocus && this.options.isVisible() && editor.contains(editor.ownerDocument.activeElement);
				const restoreReadingPosition = this.options.isVisible() ? this.options.onWillChangeRequestEditor(false) : undefined;
				this.edit.clear();
				if (returnToEdit) editTarget.focus({ preventScroll: true });
				restoreReadingPosition?.();
				this.options.onDidChangeHeight();
				this.options.onDidChangeContent();
			};
			let pending = false;
			let requestInput: IChatInputPart | undefined;
			const canClose = () => !pending && !requestInput?.isSubmitting;
			const editLease = this.options.beginRequestEdit(() => {
				if (!canClose()) return false;
				close(false);
				return true;
			});
			if (!editLease) { store.dispose(); return; }
			store.add(editLease);
			this.edit.value = store;
			const originalBounds = requestText.getBoundingClientRect();
			const restoreReadingPosition = this.options.onWillChangeRequestEditor(true);
			if (this.options.createRequestInput) editor.style.inlineSize = `${originalBounds.width}px`;
			requestText.before(editor);
			requestText.hidden = true;
			if (actions) actions.hidden = true;
			store.add(toDisposable(() => {
				editor.remove();
				requestText.hidden = false;
				if (actions) actions.hidden = false;
			}));
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
					const style = getWindow(requestText).getComputedStyle(requestText);
					const initialHeight = Math.max(0, originalBounds.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
						- parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth));
					const input = requestInput = store.add(this.options.createRequestInput({ container: editor, descriptionId: explanation.id, initialHeight, submit, reportError }));
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
			} finally {
				restoreReadingPosition();
			}
			// Wait until the outside click finishes so collapsing the editor does not move its target.
			const quickInput = this.instantiationService.getOptional(IQuickInputService);
			const dismiss = store.add(new RunOnceScheduler(() => { if (canClose()) close(false); }, 0));
			let pressedInside = false;
			store.add(addDisposableListener(editor.ownerDocument, 'pointerdown', event => {
				pressedInside = event.composedPath().includes(editor) || !!quickInput?.currentQuickInput;
			}, true));
			store.add(addDisposableListener(editor.ownerDocument, 'click', event => {
				if (canClose() && event.detail > 0 && !pressedInside && !event.composedPath().includes(editor)) dismiss.schedule();
			}, true));
			store.add(addDisposableListener(editor, 'keydown', event => {
				if (event.isComposing) return;
				if (event.key === 'Escape' && canClose()) { event.preventDefault(); event.stopPropagation(); close(); }
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
		if (!this.options.onDidRequestMemoryReference || this.options.getResponseLinkOpener?.(this.item)) return;
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
		if ((item.type === 'userContext' || item.type === 'toolCall') && (item.contextText !== undefined || item.contextEntries)) {
			if (!item.contextEntries) {
				const label = h(article.ownerDocument, 'div');
				label.className = `${this.options.classPrefix}-item-label`;
				label.textContent = this.accessibilityProvider.getAriaLabel(item);
				article.append(label);
			}
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
			if (item.contextEntries) summary.setAttribute('aria-live', 'polite');
			summary.textContent = item.contextSourceUrl ? localize('chat.context.viewSnapshot', 'View attachment snapshot') : item.text;
			const content = h(article.ownerDocument, item.contextEntries ? 'div' : 'pre');
			if (!item.contextEntries) content.tabIndex = 0;
			disclosure.open = this.options.contextExpansion.get(item.id) ?? false;
			disclosure.append(summary, content);
			article.append(disclosure);
			disposables.add(addDisposableListener(disclosure, 'toggle', () => {
				this.options.contextExpansion.set(item.id, disclosure.open);
				this.options.onDidChangeHeight();
			}));
			this.context = { disclosure, summary, content, entries: new Map() };
			this.renderContext(item, false);
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
			const openResponseLink = this.options.getResponseLinkOpener?.(item);
			const markdown = disposables.add(this.instantiationService.createInstance(ChatMarkdownContentPart, {
				ownerDocument: this.element.ownerDocument,
				getChatItem: () => this.item,
				visible: this.options.isVisible() && (item.type !== 'reasoning' || this.options.thinkingExpansion.get(item.id) === true),
				deferCodeBlockModels: this.options.deferCodeBlockModels,
				markdown: { value: item.text, supportHtml: item.markdown?.supportHtml, supportThemeIcons: true, supportAlertSyntax: true },
				markedOptions: { breaks: true },
				fillInIncompleteTokens: item.transient,
				actionHandler: openResponseLink
					? (target: string) => { void openResponseLink(target).catch(error => this.instantiationService.getOptional(INotificationService)?.error(String(error))); }
					: this.options.onDidRequestLink,
				sanitizerConfig: openResponseLink ? undefined : {
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
		if (item.conversationLink) {
			const link = item.conversationLink;
			disposables.add(new Button(body, {
				...defaultButtonStyles,
				label: link.label,
				presentation: 'secondary',
				onClick: () => this.instantiationService.invokeFunction(accessor => {
					const notifications = accessor.get(INotificationService);
					void accessor.get(IChatSessionNavigationService).openConversation(link.sessionId, link.threadId)
						.catch(error => notifications.error(error));
				}),
			}));
		}
		this.markdownPart = markdownPart;
		this.attachments = attachments;
		if (item.type === 'agentMessage') {
			if (this.options.getResponseActions) this.renderResponseActionBar(disposables);
			else this.renderCopyAction(disposables);
		} else if (requestText) {
			const actions = this.contextKeys.getValue<boolean>(IsSessionsWindowContext.key) ? undefined : this.renderCopyAction(disposables);
			if (item.requestSource) this.renderEditAction(requestText, disposables, actions);
		}
	}

	private renderContext(item: IChatListItem, completed: boolean): void {
		const context = this.context!;
		if (!item.contextSourceUrl && context.summary.textContent !== item.text) context.summary.textContent = item.text;
		if (!item.contextEntries) {
			context.content.setAttribute('aria-label', item.text);
			if (context.content.textContent !== item.contextText) context.content.textContent = item.contextText ?? '';
			return;
		}
		if (completed && context.disclosure.open) {
			if (context.content.contains(context.content.ownerDocument.activeElement)) context.summary.focus({ preventScroll: true });
			context.disclosure.open = false;
		}
		const ids = new Set(item.contextEntries.map(entry => entry.id));
		for (const [id, entry] of context.entries) {
			if (ids.has(id)) continue;
			entry.element.remove();
			context.entries.delete(id);
		}
		for (const [index, value] of item.contextEntries.entries()) {
			let entry = context.entries.get(value.id);
			if (!entry) {
				const document = context.content.ownerDocument;
				entry = { element: h(document, 'details'), summary: h(document, 'summary'), text: h(document, 'pre') };
				entry.element.append(entry.summary, entry.text);
				context.entries.set(value.id, entry);
			}
			if (entry.summary.textContent !== value.label) entry.summary.textContent = value.label;
			if (entry.text.textContent !== value.text) entry.text.textContent = value.text;
			const current = context.content.children.item(index);
			if (current !== entry.element) context.content.insertBefore(entry.element, current);
		}
	}
}

function sameItem(left: IChatListItem, right: IChatListItem): boolean {
	return left.id === right.id && left.type === right.type && left.text === right.text && left.contextText === right.contextText && left.contextSourceUrl === right.contextSourceUrl
		&& left.requestSource?.sessionId === right.requestSource?.sessionId && left.requestSource?.threadId === right.requestSource?.threadId
		&& left.requestSource?.turnId === right.requestSource?.turnId && left.requestSource?.itemId === right.requestSource?.itemId
		&& left.hookPart?.run === right.hookPart?.run
		&& left.resources === right.resources && left.markdown?.supportHtml === right.markdown?.supportHtml
		&& left.contextEntries === right.contextEntries
		&& left.conversationLink?.sessionId === right.conversationLink?.sessionId
		&& left.conversationLink?.threadId === right.conversationLink?.threadId
		&& left.conversationLink?.label === right.conversationLink?.label
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
