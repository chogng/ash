import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { isNonEmptyString, isRecord } from '../../../../base/common/types.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import type { ModelRef } from '../../../../platform/models/common/agentModels.js';
import { IQuickInputService, type IQuickPickItem, type IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import * as chatInputStatePersistence from '../../../../workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.js';
import { ISessionProviderScopeService } from '../../../browser/agentHost/sessionProviderScopeService.js';
import { Menus } from '../../../browser/menus.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import { ActivityBarItemContext } from '../../../common/contextkeys.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { NEW_CHAT_WITH_MODEL_COMMAND, SHOW_ASH_CHAT_COMMAND } from '../../chat/common/constants.js';
import { writeNewChatDraftState } from '../../chat/common/newChatDraftState.js';
import { IChatGPTService } from './chatGPTService.js';

type ChatService = 'ash' | 'chatgpt';
type ModelChoice = IQuickPickItem & (
	| { readonly service: 'ash'; readonly model: ModelRef; }
	| { readonly service: 'chatgpt'; readonly model: string; }
);

registerAction2(class NewChatWithModel extends Action2 {
	constructor() {
		super({
			id: NEW_CHAT_WITH_MODEL_COMMAND,
			title: localize2('sessions.newChatModel.title', 'New Chat with Model…'),
			f1: true,
			precondition: ContextKeyExpr.notEquals('config.chat.disableAIFeatures', true),
			menu: { id: Menus.ActivityBarContext, when: ActivityBarItemContext.isEqualTo('sessions.newSession'), group: 'navigation' },
		});
	}

	override async run(accessor: ServicesAccessor, options?: unknown): Promise<void> {
		if (options !== undefined && (!isRecord(options)
			|| (options.source !== 'ash' && options.source !== 'chatgpt')
			|| (options.text !== undefined && typeof options.text !== 'string')
			|| (options.model !== undefined && (options.source !== 'chatgpt' || !isRecord(options.model)
				|| !isNonEmptyString(options.model.provider) || !isNonEmptyString(options.model.model))))) {
			throw new TypeError('Invalid new chat model source');
		}
		if (accessor.get(IConfigurationService).getValue<boolean>('chat.disableAIFeatures')) return;
		const source = options?.source as ChatService | undefined;
		const text = options?.text as string | undefined;
		const quickInput = accessor.get(IQuickInputService);
		const commands = accessor.get(ICommandService);
		const scopes = accessor.get(ISessionProviderScopeService);
		const chatGPT = accessor.get(IChatGPTService);
		const sessions = accessor.get(ISessionsService);
		const management = accessor.get(ISessionsManagementService);
		const storage = accessor.get(IStorageService);
		const layout = accessor.get(ILayoutService);
		const model = options?.model as ModelRef | undefined;
		if (model && !(await readAshModels(scopes)).some(entry => entry.model.provider === model.provider && entry.model.model === model.model)) {
			throw new Error(localize('sessions.newChatModel.unavailable', 'The selected model is no longer available.'));
		}
		const choice = model ? { service: 'ash' as const, model } : await pickModel(quickInput, scopes, chatGPT, source);
		if (!choice) return;
		if (choice.service === 'chatgpt') {
			await chatGPT.newChatWithModel(choice.model, text);
			await commands.executeCommand('sessions.show.chatgpt');
			return;
		}
		const draft = management.createUntitledSession(undefined, undefined, LOCAL_AGENT_HOST_PROVIDER_ID, false);
		try {
			management.setUntitledSessionModel(draft.untitledSessionId, choice.model);
			if (text?.trim()) {
				writeNewChatDraftState(storage, { text, mode: 'agent', contexts: [] }, `untitled:${draft.untitledSessionId}`, chatInputStatePersistence);
			}
			await commands.executeCommand(SHOW_ASH_CHAT_COMMAND);
		} catch (error) {
			management.discardUntitledSession(draft.untitledSessionId);
			writeNewChatDraftState(storage, undefined, `untitled:${draft.untitledSessionId}`, chatInputStatePersistence);
			throw error;
		}
		sessions.openUntitledSession(draft.untitledSessionId);
		layout.focus();
	}
});

async function readAshModels(scopes: ISessionProviderScopeService) {
	const scope = scopes.getProviderScope(LOCAL_AGENT_HOST_PROVIDER_ID);
	scope.assertCurrent();
	const models = await scope.services.models.listModels();
	scope.assertCurrent();
	return models;
}

async function pickModel(
	quickInput: IQuickInputService,
	scopes: ISessionProviderScopeService,
	chatGPT: IChatGPTService,
	source: ChatService | undefined,
): Promise<ModelChoice | undefined> {
	using lifetime = new DisposableStore();
	const cancellation = new AbortController();
	lifetime.add(toDisposable(() => cancellation.abort()));
	const picker = lifetime.add(quickInput.createQuickPick<ModelChoice>());
	picker.title = localize('sessions.newChatModel.pickerTitle', 'Choose a model for a new chat');
	picker.ariaLabel = picker.title;
	picker.placeholder = localize('sessions.newChatModel.search', 'Search models');
	picker.sortByLabel = false;
	picker.busy = true;
	const readAsh = async (): Promise<ModelChoice[]> => (await readAshModels(scopes)).map(entry => ({
		service: 'ash', model: entry.model, label: entry.displayName, description: entry.source?.connectionId ?? entry.model.provider,
	}));
	const readChatGPT = async (): Promise<ModelChoice[]> => (await chatGPT.listNewChatModels(cancellation.signal)).map(model => ({
		service: 'chatgpt', model: model.id, label: model.title, description: 'ChatGPT',
	}));
	return await new Promise<ModelChoice | undefined>(resolve => {
		lifetime.add(picker.onDidHide(() => resolve(undefined)));
		lifetime.add(picker.onDidAccept(() => {
			const choice = picker.selectedItems[0];
			if (choice) resolve(choice);
		}));
		picker.show();
		const catalogs = new Map<ChatService, ModelChoice[]>();
		let unavailable = false;
		const load = async (service: ChatService, read: () => Promise<ModelChoice[]>) => {
			if (source === service) return;
			try { catalogs.set(service, await read()); }
			catch { unavailable = true; }
			if (cancellation.signal.aborted) return;
			const items: (ModelChoice | IQuickPickSeparator)[] = [];
			for (const [id, label] of [['ash', 'Ash'], ['chatgpt', 'ChatGPT']] as const) {
				const models = catalogs.get(id);
				if (models?.length) items.push({ type: 'separator', label }, ...models);
			}
			const active = picker.activeItems[0];
			picker.items = items;
			if (active && items.includes(active)) picker.activeItems = [active];
		};
		void Promise.all([load('ash', readAsh), load('chatgpt', readChatGPT)]).then(() => {
			if (cancellation.signal.aborted) return;
			picker.busy = false;
			if (!picker.items.length) picker.placeholder = localize('sessions.newChatModel.noModels', 'No models are available. Check your connection or sign in.');
			else if (unavailable) {
				picker.description = localize('sessions.newChatModel.partial', 'One model catalog is unavailable.');
			}
		});
	});
}
