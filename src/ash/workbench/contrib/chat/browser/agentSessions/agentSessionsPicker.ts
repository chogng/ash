import './media/agentSessionsPicker.css';
import { isHTMLElement } from '../../../../../base/browser/dom.js';
import { Separator } from '../../../../../base/common/actions.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { cancelOnDispose } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IAgentSessionsService, type IAgentSessionPickerItem } from './agentSessionsService.js';

export interface IAgentSessionsPickerOptions {
	overrideSessionOpen?(session: IAgentSessionPickerItem): Promise<void>;
}

/** Owns one popup and its child menu; the host retains all catalog and operation state. */
export class AgentSessionsPicker {
	constructor(
		private readonly anchor: HTMLElement | undefined,
		private readonly options: IAgentSessionsPickerOptions | undefined,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IContextMenuService private readonly menus: IContextMenuService,
		@INotificationService private readonly notifications: INotificationService,
	) { }

	pickAgentSession(): Promise<void> {
		const model = this.agentSessionsService.model;
		const disposables = new DisposableStore();
		const picker = disposables.add(this.quickInputService.createQuickPick<IAgentSessionPickerItem>());
		const dismissed = new DeferredPromise<void>();
		const cancellationToken = cancelOnDispose(disposables);
		let suspended = false;
		if (this.anchor) {
			picker.anchor = this.anchor;
			picker.width = 280;
			picker.anchorPosition = 'below';
			picker.anchorAlignment = 'right';
		}
		picker.sortByLabel = false;
		picker.ariaLabel = localize({ bundle: 'ash.sessions', key: 'command.ShowChatHistoryAction' }, 'Show Chat History');
		picker.placeholder = localize('sessions.history.placeholder', 'Select a conversation');
		const refresh = (preferredId = picker.activeItems[0]?.id): void => {
			if (suspended || picker.ignoreFocusOut || disposables.isDisposed) return;
			const items = model.items.map(item => 'type' in item ? item : { ...item, className: 'ash-chat-history-item' });
			picker.items = items;
			const active = items.find(item => !('type' in item) && item.id === preferredId);
			if (active && !('type' in active)) picker.activeItems = [active];
		};
		const runOperation = async (operation: () => unknown, closeOnSuccess = false, keepPickerOpen = false): Promise<void> => {
			if (suspended) return;
			if (keepPickerOpen) {
				picker.focus();
			} else {
				// A child prompt may take focus without ending this search's lifetime.
				suspended = true;
				picker.hide();
			}
			let succeeded = false;
			let preferredId: string | undefined;
			try {
				const result = await operation();
				preferredId = typeof result === 'string' ? result : undefined;
				succeeded = true;
			} catch (error) {
				this.notifications.error(String(error));
			} finally {
				suspended = false;
				if (!disposables.isDisposed) {
					if (succeeded && closeOnSuccess) {
						disposables.dispose();
						void dismissed.complete();
					} else {
						refresh(preferredId);
						if (!keepPickerOpen) picker.show();
					}
				}
			}
		};
		refresh();
		disposables.add(model.onDidChange(() => refresh()));
		disposables.add(picker.onDidTriggerItemButton(event => {
			const action = event.item.getButtonAction(event.button.id);
			if (action) {
				void runOperation(() => action.run(), false, action.keepPickerOpen);
				return;
			}
			if (!isHTMLElement(event.anchor)) return;
			const button = event.anchor;
			const row = button.closest('.ash-chat-history-item');
			row?.classList.add('has-open-actions');
			button.setAttribute('aria-expanded', 'true');
			picker.ignoreFocusOut = true;
			this.menus.showContextMenu({
				cancellationToken,
				// The child menu must be above the Quick Input that owns it.
				layer: 200,
				getAnchor: () => button,
				autoSelectFirstItem: true,
				getActions: () => event.item.getActions().map(action => action instanceof Separator ? action : {
					...action,
					run: () => runOperation(() => action.run(), false, action.keepPickerOpen),
				}),
				onHide: () => {
					row?.classList.remove('has-open-actions');
					button.setAttribute('aria-expanded', 'false');
					picker.ignoreFocusOut = false;
					if (!suspended && !disposables.isDisposed) {
						refresh();
						picker.focus();
					}
				},
			});
		}));
		disposables.add(picker.onDidAccept(() => {
			const item = picker.selectedItems[0];
			if (!item) return;
			void runOperation(() => this.options?.overrideSessionOpen ? this.options.overrideSessionOpen(item) : item.open(), true);
		}));
		disposables.add(picker.onDidHide(() => {
			if (suspended) return;
			disposables.dispose();
			void dismissed.complete();
		}));
		picker.show();
		return dismissed.p;
	}
}
