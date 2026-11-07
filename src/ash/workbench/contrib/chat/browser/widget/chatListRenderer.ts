import { ChatErrorContentPart } from './chatContentParts/chatErrorContentPart.js';
import { parseInlineFileReference } from '../../common/widget/annotations.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import type { ChatLayoutTrace } from './chatLayoutTrace.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { ButtonActionViewItem } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { MenuWorkbenchToolBar } from '../../../../../platform/actions/browser/toolbar.js';
import { createActionViewItem } from '../../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IMenuService, MenuId } from '../../../../../platform/actions/common/actions.js';
import { IActionViewItemService } from '../../../../../platform/actions/browser/actionViewItemService.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { ChatInputEditors, type ChatInputEditorOptions, type IChatInputEditor } from './input/chatInputEditorRegistry.js';
import { installChatInputLayout } from './input/chatInputLayout.js';
import { ChatResourceGroupWidget } from './chatContentParts/chatResourceGroupWidget.js';
import { DefaultChatAttachmentWidget } from '../attachments/chatAttachmentWidgets.js';
import { URI } from '../../../../../base/common/uri.js';
import { ChatAttachmentsContentPart, type IChatAttachmentResource } from './chatContentParts/chatAttachmentsContentPart.js';
import { addDisposableListener, getWindow, getWindowId, h } from '../../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import type { ChatTurnErrorAction, IChatListItem } from '../../common/model/chatViewModel.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { OPEN_SESSION_LINK_SCHEME } from '../../../../../platform/agentHost/common/openSessionLink.js';
import { ChatMarkdownContentPart } from './chatContentParts/chatMarkdownContentPart.js';
import { markdownFrameThreshold } from './chatContentParts/chatIncrementalRendering/chatIncrementalRendering.js';
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
import { ChatResponseFeedbackStoragePrefix, ChatUpvoteAnimationSettingId, getResponseVote, isResponseHelpful, type ChatUpvoteAnimation } from '../../common/chatResponseFeedback.js';
import { MarkHelpfulActionId } from '../actions/chatTitleActions.js';
import { ChatEditPendingRequestAction, ChatRemovePendingRequestAction, ChatSendPendingImmediatelyAction } from '../actions/chatQueueActions.js';
import type { Icon } from '../../../../../base/common/icon.js';
import { ChatForkActionViewItem } from './chatForkActionViewItem.js';
import { ChatTurnChangesPill } from './chatTurnPills.js';
import { ChatMessageActionContext, ChatResponseActionContext, type ChatTurnChangesOpener } from '../chat.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { RedoChatHistoryActionId, RestoreCheckpointActionId } from '../chatEditing/chatEditingActions.js';

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

/** The conversation model supplies row-scoped menu capabilities. */
export interface ChatResponseActions {
	/** Context keys that are true for this row. Reuse the array while the capabilities are unchanged. */
	readonly menuContext?: readonly string[];
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
	readonly openTurnChanges?: ChatTurnChangesOpener;
	readonly onDidRequestLink?: (target: string) => void;
	readonly readResponseResource?: (item: IChatListItem, resource: URI, signal: AbortSignal) => Promise<Blob>;
	readonly getResponseLinkOpener?: (item: IChatListItem) => ((target: string) => Promise<void>) | undefined;
	readonly getResponseActions?: (item: IChatListItem) => ChatResponseActions | undefined;
	readonly imageResourceLoader?: (resource: URI) => Promise<Blob>;
}

const chatEnabledContextKeys = new Set([ChatContextKeys.enabled.key]);

/** Owns one message's DOM, incremental content, actions and disposable resources. */
export class ChatListItemRenderer extends Disposable {
	public getFileTreeInfos() { return this.toolPart?.getFileTreeInfos() ?? this.resources.value?.getFileTreeInfos() ?? []; }
	public getLastFocusedFileTree() { return this.toolPart?.getLastFocusedFileTree() ?? this.resources.value?.getLastFocusedFileTree(); }
	inViewport = true;
	private readonly edit = this._register(new MutableDisposable<DisposableStore>());
	private requestActionContext: ChatMessageActionContext | undefined;
	private responseActionContext: ChatResponseActionContext | undefined;
	private updateResponseActions: ((beforeLayout?: () => void) => boolean) | undefined;
	private updateTurnChanges: (() => void) | undefined;
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
		@INotificationService private readonly notifications: INotificationService,
		@IMenuService private readonly menus: IMenuService,
		@IActionViewItemService private readonly actionViewItems: IActionViewItemService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
	) {
		super();
		this.element = h(ownerDocument, 'article');
		this.renderItem(item);
		this.refreshContent();
		this.layoutTrace.trace('renderElement', () => `create type=${item.type} chars=${item.text.length} transient=${item.transient}`);
	}

	/** Captures the scroll anchor before a synchronous row change, or queues a text-only update for the next frame. */
	public update(item: IChatListItem, beforeLayout: () => void): 'unchanged' | 'queued' | 'updated' | 'replace' {
		this.layoutTrace.trace('renderElement', () => `update type=${item.type} chars=${item.text.length} transient=${item.transient}`);
		const contentPart: IChatContentPart | undefined = this.toolPart ?? this.markdownPart;
		const same = sameItem(this.item, item);
		if (same && this.item.content === item.content && (!contentPart || contentPart.hasSameContent(item))) {
			this.item = item;
			this.requestActionContext?.update(item);
			// Providers can gain or lose response actions without changing the transcript.
			if (this.options.getResponseActions) {
				if (this.updateResponseActions?.(beforeLayout)) return 'updated';
			} else {
				this.responseActionContext?.update(item);
			}
			return 'unchanged';
		}
		if (item.text.length >= markdownFrameThreshold && this.tryQueuePlainResponse(item)) return 'queued';
		beforeLayout();
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
		} else if (this.markdownPart && !same && this.item.type === item.type && this.item.markdown?.supportHtml === item.markdown?.supportHtml && this.item.label === item.label && this.item.detail === item.detail && sameAction(this.item.action, item.action)
			&& (this.item.text === item.text && this.item.transient === item.transient
				|| this.markdownPart.tryIncrementalUpdate({ value: item.text, supportHtml: item.markdown?.supportHtml, supportThemeIcons: true, supportAlertSyntax: true }, item.transient))) {
			this.item = item;
			this.updateState();
		} else if (this.toolPart || !same) {
			return 'replace';
		}
		this.refreshContent();
		return 'updated';
	}

	/** Queues an ongoing response whose row controls and attachments are stable. */
	public tryQueuePlainResponse(item: IChatListItem): boolean {
		const previous = this.item;
		// Keep controls and attachments on the synchronous path when their inputs change.
		if (!this.markdownPart || item.type !== 'agentMessage' || !previous.transient || !item.transient || !previous.text || previous.text === item.text
			|| previous.resources?.length || item.resources?.length || this.responseActionContext?.isReading || this.options.getResponseActions
			|| previous.content?.some(part => part.type !== 'text') || item.content?.some(part => part.type !== 'text')
			|| this.options.onDidRequestMemoryReference && (this.memoryReferences.size || item.text.includes('memory:'))
			|| !sameItemPresentation(previous, item)) return false;
		if (!this.markdownPart.tryQueueIncrementalUpdate({ value: item.text, supportHtml: item.markdown?.supportHtml, supportThemeIcons: true, supportAlertSyntax: true }, item.transient)) return false;
		this.item = item;
		return true;
	}

	private updateState(): void {
		this.element.classList.toggle('error', this.item.isError === true);
		if (this.item.transient) this.element.dataset.transient = 'true';
		else delete this.element.dataset.transient;
	}

	private refreshContent(): void {
		this.updateResponseActions?.();
		this.updateTurnChanges?.();
		this.renderAttachments();
		this.renderMemoryReferences();
	}

	public setVisible(visible: boolean): void {
		if (!visible) {
			this.responseActionContext?.stop();
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

	private createMessageActions(): HTMLElement {
		const actions = h(this.element.ownerDocument, 'div');
		actions.className = 'ash-chat-message-actions';
		this.element.append(actions);
		return actions;
	}

	private createMessageToolbar(actions: HTMLElement, menu: MenuId, label: string, context: IContextKeyService, lifetime: DisposableStore): MenuWorkbenchToolBar {
		const windowId = getWindowId(getWindow(actions)) ?? 0;
		const toolbar = lifetime.add(new MenuWorkbenchToolBar(actions, this.menus, this.contextMenus, menu, {
			ariaLabel: label,
			contextKeyService: context,
			menuOptions: { shouldForwardArgs: true, renderShortTitle: true },
			actionViewItemProvider: (action, options) => {
				const buttonOptions = { ...options, iconOnly: true, buttonPresentation: 'quiet' as const };
				const factory = this.actionViewItems.lookUp(menu, action.id);
				return factory?.(action, buttonOptions, this.instantiationService, windowId)
					?? createActionViewItem(action, this.contextMenus, buttonOptions)
					?? new ButtonActionViewItem(action, buttonOptions);
			},
		}));
		lifetime.add(toolbar.actionRunner.onDidRun(event => {
			if (event.error && !this.isDisposed && !isCancellationError(event.error)) this.notifications.error(String(event.error));
		}));
		return toolbar;
	}

	private renderRequestActions(requestText: HTMLElement, lifetime: DisposableStore): HTMLElement {
		const actions = this.createMessageActions();
		const context = lifetime.add(this.contextKeys.createScoped(actions));
		ChatContextKeys.requestHasText.bindTo(context).set(!!this.item.text);
		const toolbar = this.createMessageToolbar(actions, MenuId.ChatMessageTitle, localize('chat.request.actions', 'Message actions'), context, lifetime);
		toolbar.context = this.requestActionContext = lifetime.add(new ChatMessageActionContext(this.item, actions, this.options.isVisible));
		if (this.item.requestSource) {
			const open = this.installRequestEditor(requestText, lifetime, actions, () => toolbar.focus(toolbar.getItemsLength() - 1));
			toolbar.setTrailingActions([this.messageAction('ash.chat.request.edit', localize('chat.edit.label', 'Edit message'), Lxicon.edit, open)]);
		}
		actions.prepend(toolbar.element);
		return actions;
	}

	private renderResponseFooter(lifetime: DisposableStore): void {
		const actions = this.createMessageActions();
		const context = lifetime.add(this.contextKeys.createScoped(actions));
		const hasText = ChatContextKeys.responseHasText.bindTo(context);
		const hasFeedbackSurvey = ChatContextKeys.responseHasFeedbackSurvey.bindTo(context);
		const hasConversationLink = ChatContextKeys.responseHasConversationLink.bindTo(context);
		const canFork = ChatContextKeys.responseCanFork.bindTo(context);
		const canCompareResults = ChatContextKeys.responseCanCompareResults.bindTo(context);
		const vote = this.contextKeys.getValue<boolean>(IsSessionsWindowContext.key) && !this.options.getResponseActions
			? ChatContextKeys.responseVote.bindTo(context) : undefined;
		const updateVote = () => {
			const source = !this.item.transient && !this.item.isError ? this.item.feedbackSource : undefined;
			vote?.set(source ? getResponseVote(this.storageService, source) : undefined);
		};
		if (vote) lifetime.add(this.storageService.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && event.key.startsWith(ChatResponseFeedbackStoragePrefix)) updateVote();
		}));
		const canRead = ChatContextKeys.responseCanRead.bindTo(context);
		ChatContextKeys.responseUsesNativeSpeech.bindTo(context).set(!this.options.getResponseActions);
		const reading = ChatContextKeys.responseIsReadingAloud.bindTo(context);
		const targetWindow = getWindow(this.element);
		let footer: MenuWorkbenchToolBar | undefined;
		const response = this.responseActionContext = lifetime.add(new ChatResponseActionContext(
			this.item, actions, targetWindow, this.options.isVisible, value => {
				const toolbar = footer;
				const active = actions.ownerDocument.activeElement;
				const focusedAction = toolbar && active instanceof targetWindow.HTMLElement ? toolbar.getItemAction(active) : undefined;
				const index = toolbar && focusedAction
					? Array.from({ length: toolbar.getItemsLength() }, (_, i) => toolbar.getItemAction(i)).indexOf(focusedAction)
					: -1;
				reading.set(value);
				// Read and Stop share a slot but have separate command IDs.
				if (toolbar && index >= 0 && toolbar.getItemAction(index)?.id !== focusedAction?.id) toolbar.focus(index);
			},
		));
		let menuContext: readonly string[] | undefined;
		const updateMenuContext = (nextMenuContext?: readonly string[]) => {
			hasText.set(!!this.item.text);
			canRead.set(!this.item.transient && !!this.item.text);
			const hasCompletedSource = !!this.item.feedbackSource && !this.item.transient && !this.item.isError;
			hasFeedbackSurvey.set(hasCompletedSource && this.item.canGiveModelFeedback === true);
			hasConversationLink.set(hasCompletedSource);
			canFork.set(hasCompletedSource && this.item.canForkAfterResponse === true);
			canCompareResults.set(hasCompletedSource && this.item.canCompareResults === true);
			updateVote();
			if (nextMenuContext === menuContext) return;
			for (const key of menuContext ?? []) {
				if (!nextMenuContext?.includes(key)) context.removeContext(key);
			}
			for (const key of nextMenuContext ?? []) context.setContext(key, true);
			menuContext = nextMenuContext;
		};
		const getActions = () => this.options.getResponseActions?.(this.item);
		updateMenuContext(getActions()?.menuContext);
		const toolbar = footer = this.createMessageToolbar(actions, MenuId.ChatMessageFooter, localize('chat.message.actions', 'Response actions'), context, lifetime);
		toolbar.context = response;
		actions.prepend(toolbar.element);
		let trailing: readonly IAction[] = [];
		const update = (beforeLayout?: () => void): boolean => {
			if (this.isDisposed) return false;
			const available = getActions();
			const menuChanged = available?.menuContext !== menuContext;
			if (menuChanged) beforeLayout?.();
			context.bufferChangeEvents(() => {
				response.update(this.item);
				updateMenuContext(available?.menuContext);
				if (menuChanged) response.stop();
			});
			const helpful = getHelpful?.();
			const next = helpful ? [helpful] : [];
			if (next.length === trailing.length && next.every((action, index) => trailing[index] === action)) return menuChanged;
			beforeLayout?.();
			trailing = next;
			toolbar.setTrailingActions(next);
			return true;
		};
		const getHelpful = this.options.getResponseActions || this.contextKeys.getValue<boolean>(IsSessionsWindowContext.key)
			? undefined : this.createHelpfulAction(actions, lifetime, update);
		this.updateResponseActions = update;
		lifetime.add(addDisposableListener(this.element, 'keydown', event => {
			if (event.key !== 'Escape' || !response.stop()) return;
			event.preventDefault();
			event.stopPropagation();
		}));
		this.renderTurnChanges(actions, lifetime);
	}

	private messageAction(id: string, label: string, icon: Icon, run: () => unknown): IAction {
		return {
			id, label, tooltip: label, icon, enabled: true, run: () => {
				if (!this.isDisposed && this.options.isVisible()) return run();
			},
		};
	}

	private renderTurnChanges(actions: HTMLElement, lifetime: DisposableStore): void {
		const open = this.options.openTurnChanges;
		if (open) {
			let pill: ChatTurnChangesPill | undefined;
			this.updateTurnChanges = () => {
				if (!pill && this.item.turnChanges) {
					pill = lifetime.add(this.instantiationService.createInstance(ChatTurnChangesPill, actions, this.element, async (signal: AbortSignal) => {
						if (this.options.isVisible() && this.item.turnChanges && this.item.feedbackSource) await open(this.item.feedbackSource, signal);
					}));
				}
				pill?.render(this.item.turnChanges);
			};
		}
	}

	private renderRestoreCheckpointAction(actions: HTMLElement, source: NonNullable<IChatListItem['requestSource']>, lifetime: DisposableStore): void {
		const label = localize('chat.restoreCheckpoint.messageAction', 'Restore checkpoint');
		const button = lifetime.add(new Button(actions, {
			...defaultButtonStyles, label, title: label, icon: Lxicon.history, iconOnly: true, presentation: 'quiet', size: 'small',
		}));
		const updateVisibility = () => { button.hidden = this.contextKeys.getValue(ChatContextKeys.enabled.key) !== true; };
		updateVisibility();
		lifetime.add(this.contextKeys.onDidChangeContext(event => {
			if (event.affectsSome(chatEnabledContextKeys)) updateVisibility();
		}));
		const { sessionId, threadId, itemId } = source;
		let pending = false;
		lifetime.add(button.onDidClick(async event => {
			event.stopPropagation();
			if (pending || button.hidden || !this.options.isVisible()) return;
			pending = true;
			button.domNode.setAttribute('aria-disabled', 'true');
			try {
				await this.commands.executeCommand(RestoreCheckpointActionId, { sessionId, threadId, itemId });
			} catch (error) {
				if (!this.isDisposed && !isCancellationError(error)) {
					this.notifications.error(localize('chat.restoreCheckpoint.failed', 'Could not restore the checkpoint: {0}', String(error)));
				}
			} finally {
				pending = false;
				if (!this.isDisposed) button.domNode.removeAttribute('aria-disabled');
			}
		}));
	}

	private renderRequestCheckpointMenu(actions: HTMLElement, source: NonNullable<IChatListItem['requestSource']>, lifetime: DisposableStore): void {
		const context = lifetime.add(this.contextKeys.createScoped(actions));
		ChatContextKeys.requestCanRunAnotherVersion.bindTo(context).set(this.item.canRunAnotherVersion === true);
		const toolbar = lifetime.add(new MenuWorkbenchToolBar(actions, this.menus, this.contextMenus, MenuId.ChatMessageCheckpoint, {
			ariaLabel: localize('chat.message.checkpointActions', 'Request checkpoint actions'),
			contextKeyService: context,
			menuOptions: { shouldForwardArgs: true },
		}));
		toolbar.context = source;
		lifetime.add(toolbar.actionRunner.onDidRun(event => {
			if (event.error && !this.isDisposed && !isCancellationError(event.error)) this.notifications.error(String(event.error));
		}));
	}

	private renderMessageCommandActions(
		actions: HTMLElement,
		lifetime: DisposableStore,
		commands: readonly { readonly id: string; readonly label: string; readonly icon: Icon; }[],
		getTarget: () => object | undefined,
	): () => void {
		let pending = false;
		const buttons = commands.map(command => {
			const button = lifetime.add(new Button(actions, {
				...defaultButtonStyles, label: command.label, title: command.label, icon: command.icon, iconOnly: true, presentation: 'quiet', size: 'small',
			}));
			lifetime.add(button.onDidClick(async event => {
				event.stopPropagation();
				const target = getTarget();
				if (pending || button.hidden || !target || !this.options.isVisible()) return;
				pending = true;
				for (const action of buttons) action.domNode.setAttribute('aria-disabled', 'true');
				try {
					await this.commands.executeCommand(command.id, target);
				} catch (error) {
					if (!this.isDisposed && !isCancellationError(error)) {
						this.notifications.error(localize('chat.messageAction.failed', 'Could not run {0}: {1}', command.label, String(error)));
					}
				} finally {
					pending = false;
					if (!this.isDisposed) for (const action of buttons) action.domNode.removeAttribute('aria-disabled');
				}
			}));
			return button;
		});
		const update = () => {
			const hidden = this.contextKeys.getValue(ChatContextKeys.enabled.key) !== true || !getTarget();
			for (const button of buttons) button.hidden = hidden;
		};
		lifetime.add(this.contextKeys.onDidChangeContext(event => {
			if (event.affectsSome(chatEnabledContextKeys)) update();
		}));
		update();
		return update;
	}

	private createHelpfulAction(actions: HTMLElement, lifetime: DisposableStore, update: () => void): () => IAction | undefined {
		const status = h(actions.ownerDocument, 'span');
		status.setAttribute('role', 'status');
		actions.append(status);
		const feedback = lifetime.add(new MutableDisposable());
		let pending = false;
		const getTarget = () => !this.item.transient && !this.item.isError ? this.item.feedbackSource : undefined;
		const helpful = this.messageAction(MarkHelpfulActionId, localize('chat.response.helpful', 'Helpful'), Lxicon.thumbsup, async () => {
			const target = getTarget();
			if (!target || pending) return;
			const button = actions.querySelector<HTMLElement>(`[data-action-id="${MarkHelpfulActionId}"] > button`);
			const captured = button && captureAnimationTarget(button);
			pending = true;
			status.textContent = '';
			update();
			try {
				const changed = await this.commands.executeCommand<boolean>(MarkHelpfulActionId, target);
				if (this.isDisposed || getTarget() !== target || !changed) return;
				status.textContent = localize('chat.response.helpfulSaved', 'Marked helpful in Ash.');
				const kind = this.configurationService.getValue<ChatUpvoteAnimation>(ChatUpvoteAnimationSettingId) ?? 'floatingThumbs';
				const animation = { confetti: ClickAnimation.Confetti, floatingThumbs: ClickAnimation.FloatingIcons, pulseWave: ClickAnimation.PulseWave, radiantLines: ClickAnimation.RadiantLines };
				if (captured && kind !== 'off') feedback.value = triggerClickAnimation(captured, animation[kind], Lxicon.thumbsup);
			} catch (error) {
				if (!this.isDisposed) status.textContent = localize('chat.response.helpfulFailed', 'Could not save feedback in Ash: {0}', String(error));
			} finally {
				pending = false;
				update();
			}
		});
		const tooltip = localize('chat.response.helpfulTooltip', 'Mark this response helpful in Ash');
		let action = { ...helpful, tooltip, checked: false };
		lifetime.add(this.storageService.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && event.key.startsWith(ChatResponseFeedbackStoragePrefix)) update();
		}));
		return () => {
			const target = getTarget();
			if (!target) return undefined;
			const checked = isResponseHelpful(this.storageService, target);
			const enabled = !pending;
			if (action.checked !== checked || action.enabled !== enabled) action = { ...action, checked, enabled };
			return action;
		};
	}

	private installRequestEditor(requestText: HTMLElement, lifetime: DisposableStore, actions: HTMLElement, focusEdit: () => void): () => void {
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
				if (returnToEdit) focusEdit();
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
			actions.hidden = true;
			store.add(toDisposable(() => {
				editor.remove();
				requestText.hidden = false;
				actions.hidden = false;
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
		lifetime.add(addDisposableListener(requestText, 'click', event => {
			// Keep drag-to-select available on the message text.
			const selection = requestText.ownerDocument.getSelection();
			if (event.button === 0 && (!selection || selection.isCollapsed)) open();
		}));
		return open;
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
		if (item.type === 'userMessage' || item.type === 'queuedMessage') article.classList.add('ash-chat-user-message');
		if (item.type === 'userMessage' || item.type === 'agentMessage') {
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
			this.renderResponseFooter(disposables);
		} else if (item.historyRedoTarget) {
			this.renderMessageCommandActions(this.createMessageActions(), disposables, [{
				id: RedoChatHistoryActionId, label: localize('chat.history.redoMessage', 'Redo last request'), icon: Lxicon.redo,
			}], () => this.item.historyRedoTarget);
		} else if (item.queueTarget) {
			this.renderMessageCommandActions(this.createMessageActions(), disposables, [
				{ id: ChatEditPendingRequestAction.ID, label: localize('chat.queue.rowEdit', 'Edit queued message'), icon: Lxicon.edit },
				{ id: ChatSendPendingImmediatelyAction.ID, label: localize('chat.queue.rowSendNow', 'Send queued message immediately'), icon: Lxicon.enter },
				{ id: ChatRemovePendingRequestAction.ID, label: localize('chat.queue.rowRemove', 'Remove queued message'), icon: Lxicon.close },
			], () => this.item.queueTarget);
		} else if (requestText) {
			const actions = this.renderRequestActions(requestText, disposables);
			if (!this.contextKeys.getValue<boolean>(IsSessionsWindowContext.key) && item.requestSource) {
				if (item.canForkBeforeRequest) {
					this.renderRestoreCheckpointAction(actions, item.requestSource, disposables);
					const { sessionId, threadId, itemId } = item.requestSource;
					disposables.add(this.instantiationService.createInstance(ChatForkActionViewItem, actions, { sessionId, threadId, beforeItemId: itemId }, this.options.isVisible));
				}
				if (item.canRunAnotherVersion) this.renderRequestCheckpointMenu(actions, item.requestSource, disposables);
			}
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
	return left.text === right.text && sameContent(left.content, right.content) && sameItemPresentation(left, right);
}

function sameItemPresentation(left: IChatListItem, right: IChatListItem): boolean {
	return left.id === right.id && left.type === right.type && left.contextText === right.contextText && left.contextSourceUrl === right.contextSourceUrl
		&& left.canGiveModelFeedback === right.canGiveModelFeedback && left.canForkAfterResponse === right.canForkAfterResponse
		&& left.canRunAnotherVersion === right.canRunAnotherVersion && left.canCompareResults === right.canCompareResults
		&& left.feedbackSource?.sessionId === right.feedbackSource?.sessionId
		&& left.feedbackSource?.threadId === right.feedbackSource?.threadId && left.feedbackSource?.turnId === right.feedbackSource?.turnId
		&& left.feedbackSource?.itemId === right.feedbackSource?.itemId
		&& left.turnChanges?.files === right.turnChanges?.files && left.turnChanges?.additions === right.turnChanges?.additions
		&& left.turnChanges?.deletions === right.turnChanges?.deletions
		&& left.requestSource?.sessionId === right.requestSource?.sessionId && left.requestSource?.threadId === right.requestSource?.threadId
		&& left.requestSource?.turnId === right.requestSource?.turnId && left.requestSource?.itemId === right.requestSource?.itemId
		&& left.canForkBeforeRequest === right.canForkBeforeRequest
		&& left.hookPart?.run === right.hookPart?.run
		&& left.resources === right.resources && left.markdown?.supportHtml === right.markdown?.supportHtml
		&& left.contextEntries === right.contextEntries
		&& left.conversationLink?.sessionId === right.conversationLink?.sessionId
		&& left.conversationLink?.threadId === right.conversationLink?.threadId
		&& left.conversationLink?.label === right.conversationLink?.label
		&& left.transient === right.transient && left.isError === right.isError
		&& left.label === right.label && left.detail === right.detail && left.errorCode === right.errorCode
		&& left.attachmentSource?.sessionId === right.attachmentSource?.sessionId
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
