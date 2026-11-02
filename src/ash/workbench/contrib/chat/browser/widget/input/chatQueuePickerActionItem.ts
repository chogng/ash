import './media/chatQueuePicker.css';
import { addDisposableListener, getWindow, ModifierKeyEmitter, stopEvent } from '../../../../../../base/browser/dom.js';
import { ActionViewItem, type ActionViewItemOptions } from '../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import type { Button } from '../../../../../../base/browser/ui/button/button.js';
import { AnchorPosition } from '../../../../../../base/browser/ui/contextview/contextview.js';
import type { IAction } from '../../../../../../base/common/actions.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { ActionListItemKind, type IActionListItem } from '../../../../../../platform/actionWidget/browser/actionList.js';
import { IActionWidgetService } from '../../../../../../platform/actionWidget/browser/actionWidget.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { ChatRequestQueueKind } from '../../../../../services/chat/common/chatService.js';
import { ChatConfiguration } from '../../../common/constants.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import type { Context, ContextKeyValue } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { IActionViewItemService } from '../../../../../../platform/actions/browser/actionViewItemService.js';
import { MenuId, SubmenuItemAction } from '../../../../../../platform/actions/common/actions.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';
import { ChatSubmitAction, type IChatExecuteActionContext } from '../../actions/chatExecuteActions.js';
import { ChatAskInSideChatAction, ChatQueueMessageAction, ChatSteerWithMessageAction } from '../../actions/chatQueueActions.js';
import { IChatSideChatService } from '../../../common/chatSideChatService.js';
import { LocalChatSessionUri } from '../../../common/model/chatUri.js';

/** The composer owns submission and draft lifetime; this item only chooses how to submit. */
export class ChatQueuePickerActionItem extends ActionViewItem {
	private primary: Button | undefined;
	private more: Button | undefined;
	private alternate = false;
	private menuOpen = false;
	private readonly menuLifetime = this._register(new MutableDisposable());

	constructor(
		action: IAction,
		private readonly options: ActionViewItemOptions,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IActionWidgetService private readonly menus: IActionWidgetService,
		@ICommandService private readonly commands: ICommandService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IKeybindingService private readonly keybindings: IKeybindingService,
		@IChatSideChatService private readonly sideChats: IChatSideChatService,
	) {
		super(action, options);
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ChatConfiguration.RequestQueueingDefaultAction)) {
				this.closeMenu();
				this.refresh();
			}
		}));
		this._register(contextKeys.onDidChangeContext(() => this.refresh()));
		if (action.onDidChange) this._register(action.onDidChange(() => this.refresh()));
		this._register(toDisposable(() => this.closeMenu()));
	}

	override render(container: HTMLElement): void {
		container.classList.add('ash-chat-queue-picker', 'ash-chat-input-send');
		container.setAttribute('role', 'group');
		container.setAttribute('aria-label', localize('chat.queuePicker.label', 'Send a Follow-up Message'));
		this.primary = this.createButton(container, {
			label: this.action.label, icon: Lxicon.add, iconOnly: true,
			onClick: () => this.execute(this.effectiveKind() === ChatRequestQueueKind.Queued ? ChatQueueMessageAction.ID : ChatSteerWithMessageAction.ID),
		});
		const moreLabel = localize('chat.queuePicker.more', 'More Send Options');
		this.more = this.createButton(container, {
			label: moreLabel, icon: Lxicon.chevronDown, iconOnly: true, title: moreLabel,
			onClick: () => this.menuOpen ? this.closeMenu() : this.openMenu(),
		});
		this.primary.domNode.classList.add('ash-chat-input-send-action');
		this.more.domNode.setAttribute('aria-haspopup', 'menu');
		this.more.domNode.setAttribute('aria-expanded', 'false');
		this._register(addDisposableListener(container, 'keydown', event => {
			if (event.isComposing) return;
			if (event.key === 'ArrowRight' && event.target === this.primary?.domNode) {
				stopEvent(event);
				this.more?.focus();
			} else if (event.key === 'ArrowLeft' && event.target === this.more?.domNode) {
				stopEvent(event);
				this.primary?.focus();
			} else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && event.target === this.more?.domNode) {
				stopEvent(event);
				this.openMenu();
			}
		}));
		const modifiers = ModifierKeyEmitter.getInstance(getWindow(container));
		this.alternate = modifiers.keyStatus.altKey;
		this._register(modifiers.event(status => {
			this.alternate = status.altKey;
			this.refresh();
		}));
		this.refresh();
	}

	override focus(): void { this.primary?.focus(); }

	override setActionContext(context: unknown): void {
		super.setActionContext(context ?? this.options.actionContext);
	}

	override setTabbable(tabbable: boolean): void {
		if (this.primary) this.primary.domNode.tabIndex = tabbable && this.canSubmit() ? 0 : -1;
		if (this.more) this.more.domNode.tabIndex = tabbable && this.canSubmit() ? 0 : -1;
	}

	private canSubmit(): boolean {
		return this.action.enabled && this.contextKeys.getValue<boolean>(ChatContextKeys.enabled.key) === true && this.contextKeys.getValue<boolean>(ChatContextKeys.inputHasText.key) === true
			&& this.contextKeys.getValue<boolean>(ChatContextKeys.inputBlocked.key) !== true
			&& this.contextKeys.getValue<boolean>(ChatContextKeys.transcriptProgressActive.key) !== true;
	}

	private effectiveKind(): ChatRequestQueueKind {
		const editing = this.contextKeys.getValue(ChatContextKeys.editingRequestType.key);
		const queue = editing === ChatContextKeys.EditingRequestType.Queue || editing !== ChatContextKeys.EditingRequestType.Steer && this.configuration.getValue<string>(ChatConfiguration.RequestQueueingDefaultAction) === 'queue';
		return queue !== this.alternate ? ChatRequestQueueKind.Queued : ChatRequestQueueKind.Steering;
	}

	private refresh(): void {
		if (!this.primary || !this.more) return;
		const queue = this.effectiveKind() === ChatRequestQueueKind.Queued;
		this.primary.label = queue ? localize('chat.queuePicker.queue', 'Add to Queue') : localize('chat.queuePicker.steer', 'Steer with Message');
		this.primary.icon = queue ? Lxicon.add : Lxicon.enter;
		this.primary.setTitle(this.primary.label);
		this.primary.enabled = this.more.enabled = this.canSubmit();
		if (!this.canSubmit()) this.closeMenu();
	}

	private async execute(commandId: string, current: () => boolean = () => true): Promise<void> {
		const context = this.actionContext as IChatExecuteActionContext | undefined;
		if (this.isDisposed || !this.canSubmit() || !context?.widget?.visible || !current()) return;
		this.closeMenu();
		await this.runActionWithContext({
			...this.action,
			run: () => current() ? this.commands.executeCommand(commandId, commandId === ChatSubmitAction.ID
				? { ...context, acceptInputOptions: { cancelCurrentRequest: true } }
				: context) : undefined,
		});
	}

	private openMenu(): void {
		if (!this.more || !this.canSubmit() || this.isDisposed) return;
		const widget = (this.actionContext as IChatExecuteActionContext | undefined)?.widget;
		if (!widget?.visible) return;
		const editing = this.contextKeys.getValue(ChatContextKeys.editingRequestType.key);
		const queueDefault = editing === ChatContextKeys.EditingRequestType.Queue || editing !== ChatContextKeys.EditingRequestType.Steer && this.configuration.getValue<string>(ChatConfiguration.RequestQueueingDefaultAction) === 'queue';
		const lookup: Context = {
			getValue: <T extends ContextKeyValue>(key: string) => (key === ChatContextKeys.inChatInput.key ? true : this.contextKeys.getValue(key)) as T | undefined,
		};
		const items: IActionListItem<string>[] = [
			{
				kind: ActionListItemKind.Action, label: localize('chat.queuePicker.stop', 'Stop and Send'),
				description: localize('chat.queuePicker.stopDescription', 'Stop the current task and send this message.'),
				group: { title: '', icon: Lxicon.arrowUp }, item: ChatSubmitAction.ID,
			},
			{
				kind: ActionListItemKind.Action, label: localize('chat.queuePicker.queue', 'Add to Queue'), checked: queueDefault,
				description: localize('chat.queuePicker.queueDescription', 'Send after the current task finishes without interrupting it.'),
				group: { title: '', icon: Lxicon.add }, item: ChatQueueMessageAction.ID, keybinding: this.keybindings.lookupKeybinding(ChatQueueMessageAction.ID, lookup),
			},
			{
				kind: ActionListItemKind.Action, label: localize('chat.queuePicker.steer', 'Steer with Message'), checked: !queueDefault,
				description: localize('chat.queuePicker.steerDescription', 'Give the running task additional instructions at its next opportunity.'),
				group: { title: '', icon: Lxicon.enter }, item: ChatSteerWithMessageAction.ID, keybinding: this.keybindings.lookupKeybinding(ChatSteerWithMessageAction.ID, lookup),
			},
		];
		if (editing === undefined && widget.sessionId && widget.threadId && this.sideChats.canAskInSideChat(LocalChatSessionUri.forSession(widget.sessionId, widget.threadId))) {
			items.push({
				kind: ActionListItemKind.Action, label: localize('chat.askInSideChat', 'Ask in Side Chat'), item: ChatAskInSideChatAction.ID,
				description: localize('chat.btw.description', 'Ask a side question without adding it to this conversation'), group: { title: '', icon: Lxicon.chat },
			});
		}
		this.more.focus();
		const lifetime = new DisposableStore();
		let active = true;
		const sessionId = widget.sessionId;
		const threadId = widget.threadId;
		const current = () => active && widget.visible && widget.sessionId === sessionId && widget.threadId === threadId;
		const cancel = () => { active = false; this.closeMenu(); };
		lifetime.add(widget.onDidHide(cancel));
		lifetime.add(widget.onDidChangeViewModel(cancel));
		this.menuLifetime.value = lifetime;
		this.menuOpen = true;
		this.more.domNode.setAttribute('aria-expanded', 'true');
		this.menus.show('chat.queuePicker', false, items, {
			onSelect: command => this.execute(command, current),
			onHide: () => {
				this.menuOpen = false;
				this.menuLifetime.clear();
				this.more?.domNode.setAttribute('aria-expanded', 'false');
			},
		}, this.more.domNode, { anchorPosition: AnchorPosition.Above, presentation: 'details' });
	}

	private closeMenu(): void {
		if (this.menuOpen) this.menus.hide();
	}
}

/** Registers the queue submenu presentation once for each Workbench window. */
export class ChatQueuePickerRendering extends Disposable {
	static readonly ID = 'chat.queuePickerRendering';

	constructor(@IActionViewItemService presentations: IActionViewItemService) {
		super();
		this._register(presentations.register(MenuId.ChatExecute, MenuId.ChatExecuteQueue, (action, options, instantiation) => {
			return action instanceof SubmenuItemAction ? instantiation.createInstance(ChatQueuePickerActionItem, action, options) : undefined;
		}));
	}
}
