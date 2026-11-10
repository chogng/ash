import { ChatErrorContentPart } from './chatContentParts/chatErrorContentPart.js';
import { parseInlineFileReference } from '../../common/widget/annotations.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import type { ChatLayoutTrace } from './chatLayoutTrace.js';
import { appendIcon } from '../../../../../base/browser/ui/lxicons/lxicon.js';
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
import { ChatResourceGroupWidget } from './chatContentParts/chatResourceGroupWidget.js';
import { DefaultChatAttachmentWidget } from '../attachments/chatAttachmentWidgets.js';
import { URI } from '../../../../../base/common/uri.js';
import { ChatAttachmentsContentPart, type IChatAttachmentResource } from './chatContentParts/chatAttachmentsContentPart.js';
import { addDisposableListener, getWindow, getWindowId, h } from '../../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { formatChatMessageTime, type ChatTurnErrorAction, type IChatListItem } from '../../common/model/chatViewModel.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { parseMemoryReference, type MemoryNamespace } from '../../../../../platform/memories/common/memoriesService.js';
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
import { MarkHelpfulActionId, ShowLoadedSkillsActionId } from '../actions/chatTitleActions.js';
import { ChatEditPendingRequestAction, ChatRemovePendingRequestAction, ChatSendPendingImmediatelyAction } from '../actions/chatQueueActions.js';
import type { Icon } from '../../../../../base/common/icon.js';
import { ChatForkActionViewItem } from './chatForkActionViewItem.js';
import { ChatLoadedSkillsActionViewItem, ChatTurnChangesPill } from './chatTurnPills.js';
import { ChatRequestActionContext, ChatResponseActionContext, type ChatTurnChangesOpener } from '../chat.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { EditChatRequestActionId, RedoChatHistoryActionId, RestoreCheckpointActionId } from '../chatEditing/chatEditingActions.js';

import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';

/** The conversation model supplies row-scoped menu capabilities. */
export interface ChatResponseActions {
	/** Context keys that are true for this row. Reuse the array while the capabilities are unchanged. */
	readonly menuContext?: readonly string[];
}

interface ChatListItemRendererOptions {
	readonly classPrefix: string;
	readonly messagePresentation?: import('../chat.js').ChatMessagePresentation;
	readonly onDidRequestEdit: (requestId: string) => void | Promise<void>;
	readonly canEditRequest: () => boolean;
	readonly submitRequestEdit?: (item: IChatListItem, text: string, commandId: string) => Promise<void>;
	readonly getRequestVersions?: (item: IChatListItem) => Promise<readonly import('../chat.js').ChatRequestVersion[]>;
	readonly cancelRequestEdit: () => boolean;
	readonly refreshRequestAfterEdit: () => void;
	readonly deferCodeBlockModels: boolean;
	readonly isVisible: () => boolean;
	readonly synchronousInitialRender?: boolean;
	/** Borrowed view state remains owned by the list across row replacements. */
	readonly advisorExpansion: Map<string, boolean>;
	readonly contextExpansion: Map<string, boolean>;
	readonly thinkingExpansion: Map<string, boolean>;
	readonly onDidChangeHeight: () => void;
	readonly beginRequestEdit: (close: (restoreFocus: boolean) => boolean) => IDisposable | undefined;
	readonly onWillCloseRequestEditor: (options: { readonly heightChanges: boolean; readonly sent: boolean; }) => () => void;
	readonly onDidChangeMarkdownHeight: (id: string) => void;
	readonly onDidChangeContent: () => void;
	readonly mcpAppDelegate?: IChatMcpAppDelegate;
	readonly memoryNamespace?: MemoryNamespace;
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
	private requestActionContext: ChatRequestActionContext | undefined;
	private openRequestEditor: (() => void) | undefined;
	private deferredRequestUpdate = false;
	private responseActionContext: ChatResponseActionContext | undefined;
	private updateResponseActions: ((beforeLayout?: () => void) => boolean) | undefined;
	private updateTurnChanges: (() => void) | undefined;
	private messageTime: HTMLTimeElement | undefined;
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
			const timeChanged = this.item.timestamp !== item.timestamp;
			if (timeChanged) beforeLayout();
			this.item = item;
			if (timeChanged) this.updateMessageTime();
			this.requestActionContext?.update(item);
			// Providers can gain or lose response actions without changing the transcript.
			if (this.options.getResponseActions) {
				if (this.updateResponseActions?.(beforeLayout)) return 'updated';
			} else {
				this.responseActionContext?.update(item);
			}
			return timeChanged ? 'updated' : 'unchanged';
		}
		const source = this.item.requestSource;
		const sameRequest = source
			? item.requestSource?.sessionId === source.sessionId && item.requestSource.threadId === source.threadId
			&& item.requestSource.turnId === source.turnId && item.requestSource.itemId === source.itemId
			: item.requestEdit && this.item.requestEdit && item.id === this.item.id;
		if (this.edit.value && item.type === 'userMessage' && sameRequest) {
			// Keep the editor mounted across presentation updates to the same request.
			this.deferredRequestUpdate = true;
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
		} else if (this.markdownPart && !same && this.item.type === item.type && sameFileReferenceDirectory(this.item, item) && this.item.markdown?.supportHtml === item.markdown?.supportHtml && this.item.label === item.label && this.item.detail === item.detail && sameAction(this.item.action, item.action)
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
			|| previous.timestamp !== item.timestamp || !sameItemPresentation(previous, item)) return false;
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
		this.updateMessageTime();
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
	get hasActivePlayback(): boolean { return this.responseActionContext?.isReading === true || this.media.value?.isPlaying === true; }

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
		if (this.item.type === 'userMessage' || this.item.type === 'agentMessage') {
			this.messageTime = h(this.element.ownerDocument, 'time');
			this.messageTime.className = 'ash-chat-message-time';
			actions.append(this.messageTime);
		}
		this.element.append(actions);
		return actions;
	}

	private updateMessageTime(): void {
		const time = this.messageTime;
		if (!time) return;
		const { timestamp } = this.item;
		time.hidden = timestamp === undefined;
		if (timestamp === undefined) {
			if (time.dateTime) {
				time.removeAttribute('datetime');
				time.textContent = '';
			}
			return;
		}
		const dateTime = new Date(timestamp).toISOString();
		if (time.dateTime === dateTime) return;
		time.dateTime = dateTime;
		time.textContent = formatChatMessageTime(timestamp);
	}

	private createMessageToolbar(actions: HTMLElement, menu: MenuId, label: string, context: IContextKeyService, lifetime: DisposableStore): MenuWorkbenchToolBar {
		const windowId = getWindowId(getWindow(actions)) ?? 0;
		const toolbar = lifetime.add(new MenuWorkbenchToolBar(actions, this.menus, this.contextMenus, menu, {
			ariaLabel: label,
			contextKeyService: context,
			menuOptions: { shouldForwardArgs: true, renderShortTitle: true },
			actionViewItemProvider: (action, options) => {
				const buttonOptions = { ...options, iconOnly: true, buttonPresentation: 'quiet' as const };
				if (action.id === ShowLoadedSkillsActionId && this.item.loadedSkills?.length) {
					return new ChatLoadedSkillsActionViewItem(action, buttonOptions, this.item.loadedSkills.length);
				}
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
		const editable = !!this.item.requestSource || !!(this.item.requestEdit && this.options.submitRequestEdit);
		ChatContextKeys.requestCanEdit.bindTo(context).set(editable);
		ChatContextKeys.requestHasVersions.bindTo(context).set(!!(this.item.requestHasVersions && this.options.getRequestVersions));
		const toolbar = this.createMessageToolbar(actions, MenuId.ChatMessageTitle, localize('chat.request.actions', 'Message actions'), context, lifetime);
		toolbar.context = this.requestActionContext = lifetime.add(new ChatRequestActionContext(this.item, actions, this.options.isVisible, this.options.onDidRequestEdit, this.options.getRequestVersions));
		if (editable) {
			this.installRequestEditor(requestText, lifetime, actions, () => {
				toolbar.element.querySelector<HTMLButtonElement>(`[data-action-id="${EditChatRequestActionId}"] > button`)?.focus({ preventScroll: true });
			});
			lifetime.add(addDisposableListener(this.element, 'keydown', event => {
				if (event.target !== this.element || event.key !== 'Enter' || event.isComposing || event.repeat
					|| event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !this.options.canEditRequest()) return;
				event.preventDefault();
				void this.commands.executeCommand(EditChatRequestActionId, this.requestActionContext);
			}));
		}
		actions.prepend(toolbar.element);
		return actions;
	}

	private renderResponseFooter(lifetime: DisposableStore): void {
		const actions = this.createMessageActions();
		const context = lifetime.add(this.contextKeys.createScoped(actions));
		const hasText = ChatContextKeys.responseHasText.bindTo(context);
		const hasFeedbackSurvey = ChatContextKeys.responseHasFeedbackSurvey.bindTo(context);
		const requestClientId = ChatContextKeys.responseRequestClientId.bindTo(context);
		const hasConversationLink = ChatContextKeys.responseHasConversationLink.bindTo(context);
		const hasLoadedSkills = ChatContextKeys.responseHasLoadedSkills.bindTo(context);
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
			requestClientId.set(hasCompletedSource ? this.item.requestClientId ?? '' : '');
			hasLoadedSkills.set(!!this.item.loadedSkills?.length);
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
			const previousSkillCount = response.item.loadedSkills?.length;
			const skillCount = this.item.loadedSkills?.length;
			const refreshSkillCount = !!previousSkillCount && !!skillCount && previousSkillCount !== skillCount;
			if (menuChanged || refreshSkillCount) beforeLayout?.();
			context.bufferChangeEvents(() => {
				response.update(this.item);
				updateMenuContext(available?.menuContext);
				if (menuChanged) response.stop();
			});
			if (refreshSkillCount) toolbar.refresh();
			const helpful = getHelpful?.();
			const next = helpful ? [helpful] : [];
			if (next.length === trailing.length && next.every((action, index) => trailing[index] === action)) return menuChanged || refreshSkillCount;
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

	private installRequestCheckpointMenu(requestText: HTMLElement, source: NonNullable<IChatListItem['requestSource']>, lifetime: DisposableStore): void {
		const context = lifetime.add(this.contextKeys.createScoped(requestText));
		ChatContextKeys.requestCanRunAnotherVersion.bindTo(context).set(true);
		const menu = lifetime.add(this.menus.createMenu(MenuId.ChatMessageCheckpoint, context));
		const showMenu = (event: MouseEvent | KeyboardEvent) => {
			const actions = menu.getActions({ arg: source }).flatMap(([, group]) => group);
			if (!actions.length) return;
			event.preventDefault();
			event.stopPropagation();
			this.contextMenus.showContextMenu({
				getAnchor: () => 'clientX' in event ? { x: event.clientX, y: event.clientY, targetWindow: getWindow(requestText) } : requestText,
				getActions: () => actions,
			});
		};
		lifetime.add(addDisposableListener(requestText, 'contextmenu', event => {
			if (requestText.ownerDocument.getSelection()?.isCollapsed !== false) showMenu(event);
		}));
		lifetime.add(addDisposableListener(this.element, 'keydown', event => {
			if (event.target === this.element && (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) showMenu(event);
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

	public startEditing(): void {
		if (!this.isDisposed) this.openRequestEditor?.();
	}

	private installRequestEditor(requestText: HTMLElement, lifetime: DisposableStore, actions: HTMLElement, focusEdit: () => void): void {
		const bubble = h(this.element.ownerDocument, 'div', { className: 'ash-chat-request-bubble' });
		requestText.before(bubble);
		bubble.append(requestText);
		requestText.classList.add('ash-chat-request-editable');
		this.openRequestEditor = () => {
			if (this.edit.value || !this.options.isVisible() || !this.options.canEditRequest()) return;
			const item = this.item;
			const source = item.requestSource;
			const submit = this.options.submitRequestEdit;
			if (!source && !(item.requestEdit && submit)) return;
			const store = new DisposableStore();
			const document = this.element.ownerDocument;
			const input = h(document, 'textarea', { className: 'ash-chat-request-editor' });
			input.value = item.requestEdit?.text ?? item.text;
			input.setAttribute('aria-label', localize('chat.edit.input', 'Edit request'));
			const explanation = h(document, 'span');
			explanation.id = createUuid();
			explanation.hidden = true;
			explanation.textContent = item.requestEdit?.description ?? localize('chat.edit.description', 'Sending creates a new chat from before this request. Its context and attachments are kept; the original chat and draft stay available.');
			input.setAttribute('aria-describedby', explanation.id);
			const feedback = h(document, 'div', { className: 'ash-chat-request-edit-feedback' });
			feedback.setAttribute('role', 'status');
			const controls = h(document, 'div', { className: 'ash-chat-request-edit-actions' });
			const cancel = store.add(new Button(controls, {
				...defaultButtonStyles, label: localize('chat.edit.cancelButton', 'Cancel'), ariaLabel: localize('chat.edit.cancelLabel', 'Cancel edit'),
				presentation: 'secondary', size: 'small',
			}));
			const send = store.add(new Button(controls, {
				...defaultButtonStyles, label: localize('chat.edit.sendButton', 'Send'), ariaLabel: localize('chat.edit.resend', 'Send edited request'),
				presentation: 'primary', size: 'small',
			}));
			const isInside = (target: Node | null) => bubble.contains(target) || controls.contains(target);
			const close = (restoreFocus: boolean, sent = false): void => {
				const visible = this.options.isVisible();
				const returnToEdit = restoreFocus && visible && isInside(document.activeElement);
				const finishClose = visible ? this.options.onWillCloseRequestEditor({
					heightChanges: !!feedback.textContent && feedback.offsetHeight > 0,
					sent,
				}) : undefined;
				this.edit.clear();
				if (returnToEdit) focusEdit();
				finishClose?.();
				this.options.onDidChangeContent();
				if (this.deferredRequestUpdate) {
					this.deferredRequestUpdate = false;
					this.options.refreshRequestAfterEdit();
				}
			};
			let pending = false;
			const editLease = this.options.beginRequestEdit(restoreFocus => {
				if (pending) return false;
				close(restoreFocus);
				return true;
			});
			if (!editLease) { store.dispose(); return; }
			store.add(editLease);
			this.edit.value = store;
			// The read-only bubble and actions still size the row while their replacements are overlaid.
			requestText.classList.add('ash-chat-request-editing');
			bubble.append(input, explanation);
			actions.append(controls);
			actions.after(feedback);
			store.add(toDisposable(() => {
				input.remove();
				explanation.remove();
				controls.remove();
				feedback.remove();
				requestText.classList.remove('ash-chat-request-editing');
			}));
			let attempt: { text: string; commandId: string; } | undefined;
			const updateSend = () => { send.enabled = !pending && !!input.value.trim(); };
			const sendEdit = async (): Promise<void> => {
				const text = input.value;
				if (pending || !text.trim() || this.isDisposed || !this.options.isVisible()) return;
				if (!this.options.canEditRequest()) {
					feedback.textContent = localize('chat.edit.blocked', 'The conversation is currently unavailable for editing.');
					return;
				}
				if (attempt?.text !== text) attempt = { text, commandId: createUuid() };
				pending = true;
				input.readOnly = true;
				input.setAttribute('aria-busy', 'true');
				if (controls.contains(document.activeElement)) input.focus({ preventScroll: true });
				updateSend();
				cancel.enabled = false;
				feedback.textContent = '';
				try {
					if (submit) await submit(item, text, attempt.commandId);
					else await this.commands.executeCommand('workbench.action.chat.resendRequest', { ...source, text, commandId: attempt.commandId });
					if (this.edit.value === store) close(true, true);
				} catch (error) {
					if (this.edit.value === store && !isCancellationError(error)) feedback.textContent = localize('chat.edit.failed', 'Could not send the edited request: {0}', String(error));
				} finally {
					if (this.edit.value === store) {
						pending = false;
						input.readOnly = false;
						input.removeAttribute('aria-busy');
						updateSend();
						cancel.enabled = true;
					}
				}
			};
			updateSend();
			store.add(send.onDidClick(() => void sendEdit()));
			store.add(cancel.onDidClick(() => this.options.cancelRequestEdit()));
			store.add(addDisposableListener(input, 'input', updateSend));
			store.add(addDisposableListener(this.element, 'keydown', event => {
				if (event.isComposing || !isInside(document.activeElement)) return;
				if (event.key === 'Escape' && this.options.cancelRequestEdit()) {
					event.preventDefault();
					event.stopPropagation();
				} else if (event.target === input && event.key === 'Enter' && !event.shiftKey && (event.ctrlKey || event.metaKey)) {
					event.preventDefault();
					event.stopPropagation();
					void sendEdit();
				}
			}));
			input.setSelectionRange(input.value.length, input.value.length);
			input.focus({ preventScroll: true });

			// Wait until the outside click finishes so closing the editor does not interfere with its target.
			const quickInput = this.instantiationService.getOptional(IQuickInputService);
			const dismiss = store.add(new RunOnceScheduler(() => { if (!pending) close(false); }, 0));
			let pressedInside = false;
			store.add(addDisposableListener(document, 'pointerdown', event => {
				pressedInside = event.composedPath().some(target => target === bubble || target === controls) || !!quickInput?.currentQuickInput;
			}, true));
			store.add(addDisposableListener(document, 'click', event => {
				if (!pending && event.detail > 0 && !pressedInside && !event.composedPath().some(target => target === bubble || target === controls)) dismiss.schedule();
			}, true));
			this.options.onDidChangeContent();
		};
		lifetime.add(addDisposableListener(requestText, 'click', event => {
			// Keep drag-to-select available on the message text.
			const selection = requestText.ownerDocument.getSelection();
			if (event.button === 0 && (!selection || selection.isCollapsed)) void this.options.onDidRequestEdit(this.item.id);
		}));
	}

	private renderMemoryReferences(): void {
		if (!this.options.onDidRequestMemoryReference || this.options.getResponseLinkOpener?.(this.item)) return;
		const references = [...new Set(this.item.text.match(/memory:[A-Za-z0-9_-]+/g) ?? [])].filter(reference => parseMemoryReference(reference, this.options.memoryNamespace ?? 'code')).slice(0, 8);
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
		if (item.type === 'skillLoad') {
			const line = h(article.ownerDocument, 'div', { className: 'ash-chat-skill-activity' });
			const icon = h(article.ownerDocument, 'span', { className: 'ash-chat-tool-status-icon', attributes: { 'aria-hidden': 'true' } });
			appendIcon(Lxicon.skill, icon);
			line.append(icon, this.accessibilityProvider.getAriaLabel(item), ' · ', item.text);
			article.append(line);
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
			const presentation = this.options.messagePresentation;
			const participant = item.type === 'userMessage' ? presentation?.user : presentation?.assistant;
			article.setAttribute('aria-label', participant?.name ?? this.accessibilityProvider.getAriaLabel(item));
			if (participant) {
				const document = article.ownerDocument;
				const avatar = h(document, 'span', { className: 'ash-chat-participant-avatar', attributes: { 'aria-hidden': 'true' } });
				if (participant.icon) appendIcon(participant.icon, avatar);
				article.append(h(document, 'header', { className: 'ash-chat-participant' }, avatar, h(document, 'span', participant.name)));
			}
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
				synchronousInitialRender: this.options.synchronousInitialRender,
				fillInIncompleteTokens: item.transient,
				fileReferenceDirectory: !openResponseLink && this.options.onDidRequestLink ? item.fileReferenceDirectory : undefined,
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
		const references = this.options.messagePresentation?.getReferences?.(item);
		if (references?.length) {
			const actions = h(article.ownerDocument, 'div', { className: 'ash-chat-message-references' });
			body.append(actions);
			for (const reference of references) {
				const button = disposables.add(new Button(actions, {
					...defaultButtonStyles, label: reference.label, icon: Lxicon.codeReview,
					presentation: 'quiet', size: 'small',
				}));
				button.domNode.dataset.chatReferenceId = reference.id;
				disposables.add(button.onDidClick(() => reference.open(button.domNode)));
			}
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
			}
			if (item.canRunAnotherVersion && item.requestSource) this.installRequestCheckpointMenu(requestText, item.requestSource, disposables);
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
		&& left.requestClientId === right.requestClientId
		&& left.turnChanges?.files === right.turnChanges?.files && left.turnChanges?.additions === right.turnChanges?.additions
		&& left.turnChanges?.deletions === right.turnChanges?.deletions
		&& left.requestSource?.sessionId === right.requestSource?.sessionId && left.requestSource?.threadId === right.requestSource?.threadId
		&& left.requestSource?.turnId === right.requestSource?.turnId && left.requestSource?.itemId === right.requestSource?.itemId
		&& left.requestEdit?.text === right.requestEdit?.text && left.requestEdit?.description === right.requestEdit?.description
		&& left.requestHasVersions === right.requestHasVersions
		&& left.canForkBeforeRequest === right.canForkBeforeRequest
		&& left.loadedSkills?.length === right.loadedSkills?.length
		&& (left.loadedSkills?.every((skill, index) => skill === right.loadedSkills?.[index]) ?? true)
		&& left.hookPart?.run === right.hookPart?.run
		&& sameFileReferenceDirectory(left, right)
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

function sameFileReferenceDirectory(left: IChatListItem, right: IChatListItem): boolean {
	const a = left.fileReferenceDirectory;
	const b = right.fileReferenceDirectory;
	if (a === b) return true;
	if (!a || !b || a.resource.toString() !== b.resource.toString()) return false;
	return a.target.type === 'session' && b.target.type === 'session'
		? a.target.sessionId === b.target.sessionId && a.target.path === b.target.path
		: a.target.type === 'workspace' && b.target.type === 'workspace' && a.target.dirId === b.target.dirId;
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
