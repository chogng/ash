import { ISessionsProvidersService } from '../../services/sessions/browser/sessionsProvidersService.js';
import { sessionManagementLabel } from '../sessionManagementLabels.js';
import { localize2, localize } from '../../../nls.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { Action2, registerAction2 } from '../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, type IQuickPickItem } from '../../../platform/quickinput/common/quickInput.js';
import { NEW_CHAT_COMMAND_ID, SHOW_CHAT_HISTORY_COMMAND_ID, OPEN_CHAT_PERMISSIONS_COMMAND_ID } from '../../../workbench/contrib/chat/common/chat.js';
import { CommandsRegistry, ICommandService } from '../../../platform/commands/common/commands.js';
import type { IUntitledChatSession, SessionId, ThreadId } from '../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../services/sessions/browser/sessionsService.js';
import { approvalModeDefinitions } from '../../../platform/agentHost/common/approvalModes.js';
import type { IChatWidgetModel } from '../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { ForkConversationAction } from '../../../workbench/contrib/chat/browser/actions/chatForkActions.js';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { SessionsWorkspaceModeContext } from '../../common/contextkeys.js';
import { ILayoutService } from '../../../platform/layout/browser/layoutService.js';
import { ISessionsLayoutService } from '../../services/layout/common/sessionsLayoutService.js';

import { IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { ILanguageModelsService } from '../../../workbench/contrib/chat/common/languageModels.js';
import type { ModelReasoningEffort } from '../../../workbench/services/chat/common/modelCatalog.js';

registerAction2(
	class extends ForkConversationAction {
		protected override readonly target = 'thread' as const;
	},
);

registerAction2(
	class ChoosePermission extends Action2 {
		constructor() {
			super({
				id: OPEN_CHAT_PERMISSIONS_COMMAND_ID,
				title: localize2('sessions.chat.permissions', 'Permissions'),
			});
		}
		override async run(accessor: ServicesAccessor, model: IChatWidgetModel, argument = ''): Promise<void> {
			const value = argument.trim();
			const definition = value ? approvalModeDefinitions.find(mode => mode.id === value) : undefined;
			if (value && !definition) {
				throw new Error(localize('sessions.chat.permission.commandUsage', 'Use /permission manual|auto|bypassPermissions.'));
			}
			const selected =
				definition?.id ??
				(
					await selectReviewItem(
						accessor.get(IQuickInputService),
						localize('sessions.chat.permissions', 'Permissions'),
						approvalModeDefinitions.map(mode => ({
							id: mode.id,
							label: localize(mode.label.key, mode.label.text),
							description: localize(mode.description.key, mode.description.text),
						})),
					)
				)?.id;
			if (selected) {
				await accessor.get(ICommandService).executeCommand(`sessions.chat.permission.${selected}`, model);
			}
		}
	},
);

for (const definition of approvalModeDefinitions) {
	const mode = definition.id;
	registerAction2(
		class SelectSessionApprovalMode extends Action2 {
			constructor() {
				super({
					id: `sessions.chat.permission.${mode}`,
					title: localize2({ bundle: 'ash', key: definition.label.key }, definition.label.text),
				});
			}

			override async run(accessor: ServicesAccessor, model: IChatWidgetModel): Promise<void> {
				if (definition.requiresConfirmation) {
					const result = await accessor.get(IDialogService).confirm({
						message: localize('sessions.chat.permission.fullWarning', 'Skip most permission approvals?'),
						detail: localize(
							'sessions.chat.permission.fullDetail',
							'Commands may change or delete files and perform external actions without asking. File and network access limits still apply. Plan and Ask remain analysis modes.',
						),
						primaryButton: localize(definition.label.key, definition.label.text),
					});
					if (!result.confirmed) {
						return;
					}
				}
				// The menu carries its own composer model, including when another pane is active.
				model.selectApprovalMode(mode);
			}
		},
	);
}

registerAction2(
	class SelectApprovalReviewModel extends Action2 {
		constructor() {
			super({
				id: 'sessions.chat.permission.reviewModel',
				title: localize2({ bundle: 'ash', key: 'sessions.chat.permission.reviewModel' }, 'Review model…'),
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const models = accessor.get(ILanguageModelsService);
			const input = accessor.get(IQuickInputService);
			const [selection, providers] = await Promise.all([models.readApprovalReviewModel(), models.listModelProviders()]);
			const connection = await selectReviewItem(
				input,
				localize('sessions.chat.permission.reviewConnection', 'Choose the review connection'),
				[
					{
						label: localize('sessions.chat.permission.reviewDefault', 'Automatic (connection default)'),
						id: 'automatic',
						description: localize('sessions.chat.permission.reviewDefaults', 'ChatGPT subscription: codex-auto-review; OpenAI API: GPT-6 Luna, low'),
					},
					...providers
						.filter(provider => provider.configured)
						.map(provider => ({
							label: provider.displayName,
							id: provider.connection,
							description: provider.connection,
						})),
				],
				selection.type === 'explicit' ? selection.connection : 'automatic',
			);
			if (!connection) {
				return;
			}
			if (connection.id === 'automatic') {
				await models.setApprovalReviewModel({ type: 'automatic' });
				return;
			}
			const provider = providers.find(provider => provider.connection === connection.id)!;
			const catalog = (await models.listModelCatalog()).filter(entry => entry.model.provider === provider.provider);
			const choice = await selectReviewItem(
				input,
				localize('sessions.chat.permission.reviewModel', 'Review model…'),
				[
					...catalog.map(entry => ({
						label: entry.displayName,
						id: entry.model.model,
						description: entry.model.model,
					})),
					{
						label: localize('sessions.chat.permission.reviewCustom', 'Enter model ID…'),
						id: 'custom-model-id',
					},
				],
				selection.type === 'explicit' ? selection.model.model : undefined,
			);
			if (!choice) {
				return;
			}
			const modelId =
				choice.id === 'custom-model-id'
					? (
							await input.input({
								title: localize('sessions.chat.permission.reviewCustomPrompt', 'Model ID supported by this connection'),
								value: selection.type === 'explicit' ? selection.model.model : '',
							})
						)?.trim()
					: choice.id;
			if (!modelId) {
				return;
			}
			const entry = catalog.find(entry => entry.model.model === modelId);
			const efforts = entry?.supportedReasoningEfforts ?? [];
			const effort = await selectReviewItem(
				input,
				localize('sessions.chat.permission.reviewEffort', 'Review thinking effort'),
				[
					{
						label: localize('sessions.chat.permission.reviewEffortDefault', 'Automatic (review default)'),
						id: 'automatic',
					},
					...efforts.map(option => ({
						label: option.effort,
						id: option.effort,
						description: option.description ?? undefined,
					})),
				],
				selection.type === 'explicit' ? selection.reasoningEffort : 'automatic',
			);
			if (!effort) {
				return;
			}
			await models.setApprovalReviewModel({
				type: 'explicit',
				connection: connection.id,
				model: { provider: provider.provider, model: modelId },
				...(effort.id !== 'automatic' ? { reasoningEffort: effort.id as ModelReasoningEffort } : {}),
			});
		}
	},
);

interface ReviewPickItem extends IQuickPickItem {
	readonly id: string;
}

function selectReviewItem(input: IQuickInputService, title: string, items: readonly ReviewPickItem[], selectedId?: string): Promise<ReviewPickItem | undefined> {
	return new Promise(resolve => {
		const disposables = new DisposableStore();
		const picker = disposables.add(input.createQuickPick<ReviewPickItem>());
		picker.placeholder = title;
		picker.ariaLabel = title;
		picker.items = items.map(item => ({ ...item, picked: item.id === selectedId }));
		disposables.add(
			picker.onDidAccept(() => {
				const item = picker.selectedItems[0];
				if (!item) return;
				resolve(item);
				picker.hide();
			}),
		);
		disposables.add(
			picker.onDidHide(() => {
				resolve(undefined);
				disposables.dispose();
			}),
		);
		picker.show();
	});
}

// ChatWidget shares these command IDs with the regular Workbench; this window owns their Sessions behavior.
registerAction2(
	class NewSessionsChatAction extends Action2 {
		constructor() {
			super({
				id: NEW_CHAT_COMMAND_ID,
				title: localize2({ bundle: 'ash', key: 'chat.sessions.new' }, 'New Session'),
			});
		}

		override async run(accessor: ServicesAccessor): Promise<IUntitledChatSession | undefined> {
			const view = accessor.get(ISessionsService);
			const providers = accessor.get(ISessionsProvidersService).getProviders();
			if (providers.length < 2) {
				return view.openNewSession(localize('chat.sessions.new', 'New Session'));
			}
			using picker = accessor.get(IQuickInputService).createQuickPick<IQuickPickItem & { providerId: string }>();
			picker.placeholder = localize('sessions.new.chooseHost', 'Choose a host for the new session');
			picker.items = providers.map(provider => ({ label: provider.label, providerId: provider.id }));
			const chosen = await new Promise<(IQuickPickItem & { providerId: string }) | undefined>(resolve => {
				const lifetime = new DisposableStore();
				lifetime.add(
					picker.onDidAccept(() => {
						const item = picker.selectedItems[0];
						if (item) {
							resolve(item);
							picker.hide();
							lifetime.dispose();
						}
					}),
				);
				lifetime.add(
					picker.onDidHide(() => {
						resolve(undefined);
						lifetime.dispose();
					}),
				);
				picker.show();
			});
			if (chosen) {
				return view.openNewSession(localize('chat.sessions.new', 'New Session'), {
					providerId: chosen.providerId,
				});
			}
		}
	},
);

registerAction2(
	class NewSessionFromNavigationAction extends Action2 {
		constructor() {
			super({ id: 'sessions.newSession', title: localize2('sessions.activity.new', 'New') });
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const commands = accessor.get(ICommandService);
			const mode = accessor.get(IContextKeyService).getValue(SessionsWorkspaceModeContext.key);
			const entryCommand = accessor.get(ISessionsLayoutService).newSessionCommand;
			if (entryCommand) {
				await commands.executeCommand(entryCommand);
				return;
			}
			if (mode !== 'code' && CommandsRegistry.hasCommand('sessions.open.new')) {
				await commands.executeCommand('sessions.open.new');
				return;
			}
			const created = await commands.executeCommand<IUntitledChatSession | undefined>(NEW_CHAT_COMMAND_ID);
			if (created) {
				await commands.executeCommand(mode === 'code' ? 'sessions.open.code' : 'sessions.open.chat');
				accessor.get(ILayoutService).focus();
			}
		}
	},
);

interface SessionsHistoryQuickPickItem extends IQuickPickItem {
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
}

registerAction2(
	class ShowSessionsChatHistoryAction extends Action2 {
		constructor() {
			super({
				id: SHOW_CHAT_HISTORY_COMMAND_ID,
				f1: true,
				title: localize2({ bundle: 'ash.sessions', key: 'command.ShowSessionsChatHistoryAction' }, 'Show Session History'),
			});
		}

		override run(accessor: ServicesAccessor): void {
			const sessions = accessor.get(ISessionsManagementService);
			const view = accessor.get(ISessionsService);
			const quickPick = accessor.get(IQuickInputService).createQuickPick<SessionsHistoryQuickPickItem>();
			const disposables = new DisposableStore();
			disposables.add(quickPick);
			quickPick.placeholder = 'Select a session';
			quickPick.items = sessions.sessions.flatMap(session => {
				if (session.status !== 'active') return [];
				const threads = session.chats.filter(thread => thread.status === 'active');
				return threads.map((thread, index) => ({
					sessionId: session.sessionId,
					threadId: thread.threadId,
					label: session.title.trim() || 'Session',
					description:
						[
							session.application?.label,
							threads.length > 1 ? localize('sessions.history.thread', 'Thread {0}', index + 1) : undefined,
							thread.origin.type !== 'root' && thread.title?.trim() !== session.title.trim() ? thread.title?.trim() : undefined,
							sessionManagementLabel(thread.management),
						]
							.filter(Boolean)
							.join(' · ') || undefined,
					detail: thread.management?.activity?.text ?? thread.management?.summary ?? undefined,
				}));
			});
			disposables.add(
				quickPick.onDidAccept(() => {
					const item = quickPick.selectedItems[0];
					if (!item) return;

					view.openSession(item.sessionId, item.threadId);
					quickPick.hide();
				}),
			);
			disposables.add(quickPick.onDidHide(() => disposables.dispose()));
			quickPick.show();
		}
	},
);
