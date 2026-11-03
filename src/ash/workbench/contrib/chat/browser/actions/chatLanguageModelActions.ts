import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IPreferencesService } from '../../../../services/preferences/common/preferences.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { ILanguageModelsService } from '../../common/languageModels.js';
import { CHAT_CATEGORY } from './chatActions.js';

async function choose<T extends IQuickPickItem>(input: IQuickInputService, title: string, items: readonly T[]): Promise<T | undefined> {
	using picker = input.createQuickPick<T>();
	using listeners = new DisposableStore();
	picker.title = title;
	picker.items = items;
	return await new Promise<T | undefined>(resolve => {
		listeners.add(picker.onDidAccept(() => { const item = picker.selectedItems[0]; if (item) { resolve(item); picker.hide(); } }));
		listeners.add(picker.onDidHide(() => resolve(undefined)));
		picker.show();
	});
}

class ManageLanguageModelAuthenticationAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.manageLanguageModelAuthentication', category: CHAT_CATEGORY,
			title: localize2('chat.models.manageAccess', 'Manage Language Model Access...'),
			f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const configuration = accessor.get(IConfigurationService);
		if (configuration.getValue<boolean>(ChatAIDisabledSettingId)) return;
		const models = accessor.get(ILanguageModelsService);
		const input = accessor.get(IQuickInputService);
		const dialogs = accessor.get(IDialogService);
		const preferences = accessor.get(IPreferencesService);
		const providers = await models.listModelProviders();
		if (configuration.getValue<boolean>(ChatAIDisabledSettingId)) return;
		if (!providers.length) {
			await preferences.openSettings({ section: 'models', query: '', sectionQuery: '', jsonEditor: false, focusSearch: true });
			return;
		}
		const selected = await choose(input, localize('chat.models.chooseAccess', 'Choose a model connection'), providers.map(provider => ({
			label: provider.displayName, description: provider.connection, provider,
			detail: provider.ready ? localize('chat.models.accessReady', 'Ready') : localize('chat.models.accessNotReady', 'Not ready'),
		})));
		if (!selected || configuration.getValue<boolean>(ChatAIDisabledSettingId)) return;
		const provider = selected.provider;
		const actions: Array<IQuickPickItem & { action: 'settings' | 'update' | 'remove'; }> = [];
		if (provider.apiKeyPolicy !== 'unsupported') {
			actions.push({ action: 'update', label: localize('chat.models.updateKey', 'Set API Key...') });
			if (provider.apiKeyConfigured) actions.push({ action: 'remove', label: localize('chat.models.removeKey', 'Remove API Key...') });
		}
		actions.push({ action: 'settings', label: localize('chat.models.accessSettings', 'Open Models Settings') });
		const action = await choose(input, provider.displayName, actions);
		if (!action || configuration.getValue<boolean>(ChatAIDisabledSettingId)) return;
		if (action.action === 'settings') {
			await preferences.openSettings({ section: 'models', query: '', sectionQuery: provider.connection, jsonEditor: false, focusSearch: true });
		} else if (action.action === 'update') {
			const key = await input.input({
				title: localize('chat.models.keyFor', 'API key for {0}', provider.displayName), password: true,
				validateInput: async value => value.trim() ? undefined : localize('chat.models.emptyKey', 'Enter an API key.'),
			});
			if (key !== undefined && !configuration.getValue<boolean>(ChatAIDisabledSettingId)) await models.setModelProviderApiKey(provider.connection, key);
		} else {
			const confirmation = await dialogs.confirm({
				message: localize('chat.models.confirmRemoveKey', 'Remove the API key for {0}?', provider.displayName),
				detail: localize('chat.models.removeKeyDetail', 'The saved connection remains. Requests that require this key will need new credentials.'),
				primaryButton: localize('chat.models.removeKeyButton', 'Remove API Key'),
			});
			if (confirmation.confirmed && !configuration.getValue<boolean>(ChatAIDisabledSettingId)) await models.removeModelProviderApiKey(provider.connection);
		}
	}
}

export function registerLanguageModelActions(): void {
	registerAction2(ManageLanguageModelAuthenticationAction);
}
