import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IChatEntitlementService } from '../../../../services/chat/common/chatEntitlementService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { MANAGE_CHAT_COMMAND_ID } from '../../common/constants.js';
import { CHAT_SETUP_ACTION_ID } from '../actions/chatActions.js';

/** Window-owned setup entry points share the configuration projection across both hosts. */
export class ChatSetupContribution extends Disposable {
	public static readonly ID = 'workbench.contrib.chatSetup';

	constructor(
		@IChatEntitlementService entitlementService: IChatEntitlementService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		const enabled = ChatContextKeys.enabled.bindTo(contextKeyService);
		const hidden = ChatContextKeys.Setup.hidden.bindTo(contextKeyService);
		const update = (): void => {
			const isHidden = entitlementService.sentiment.hidden === true;
			contextKeyService.bufferChangeEvents(() => {
				hidden.set(isHidden);
				enabled.set(!isHidden);
			});
		};
		update();
		this._register(entitlementService.onDidChangeSentiment(update));
		this._register(toDisposable(() => {
			enabled.reset();
			hidden.reset();
		}));
		const activeSetup = this._register(new MutableDisposable<DisposableStore>());
		this._register(registerAction2(class ChatSetupTriggerAction extends Action2 {
			constructor() {
				super({
					id: CHAT_SETUP_ACTION_ID,
					title: localize2('chat.setup.title', 'Chat: Set Up Chat'),
					f1: true,
					precondition: ChatContextKeys.enabled.isEqualTo(true),
				});
			}

			public override run(accessor: ServicesAccessor): void {
				const entitlement = accessor.get(IChatEntitlementService);
				if (entitlement.sentiment.hidden) { return; }
				const commands = accessor.get(ICommandService);
				const quickInput = accessor.get(IQuickInputService);
				const notifications = accessor.get(INotificationService);
				if (activeSetup.value) { quickInput.focus(); return; }
				const resources = new DisposableStore();
				activeSetup.value = resources;
				const picker = resources.add(quickInput.createQuickPick<IQuickPickItem & { readonly commandId: string; }>());
				picker.placeholder = localize('chat.setup.placeholder', 'Choose how to set up Chat');
				picker.ariaLabel = picker.placeholder;
				picker.items = [
					{
						label: localize('chat.setup.models', 'Configure Model Connections'),
						description: localize('chat.setup.models.description', 'Add an API key, configure a local endpoint, or choose models.'),
						commandId: MANAGE_CHAT_COMMAND_ID,
					},
					{
						label: localize('chat.setup.accounts', 'Manage Accounts'),
						description: localize('chat.setup.accounts.description', 'Sign in to a supported subscription or reconnect an account.'),
						commandId: 'workbench.action.manageAccounts',
					},
				];
				resources.add(picker.onDidAccept(() => {
					const choice = picker.selectedItems[0];
					if (!choice) { return; }
					picker.hide();
					if (entitlement.sentiment.hidden) { return; }
					// Navigation does not certify readiness or submit the composer's retained draft.
					void commands.executeCommand(choice.commandId).catch(error => notifications.error(error));
				}));
				resources.add(picker.onDidHide(() => activeSetup.clear()));
				resources.add(entitlement.onDidChangeSentiment(() => {
					if (entitlement.sentiment.hidden) { picker.hide(); }
				}));
				picker.show();
			}
		}));
	}
}
