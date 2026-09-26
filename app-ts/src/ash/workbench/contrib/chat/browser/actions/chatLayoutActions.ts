import { Lxicon } from "../../../../../base/common/lxicons.js";
import { DisposableStore } from "../../../../../base/common/lifecycle.js";
import { localize } from "../../../../../nls.js";
import { Action2, MenuId, registerAction2 } from "../../../../../platform/actions/common/actions.js";
import { ContextKeyExpr } from "../../../../../platform/contextkey/common/contextkey.js";
import { DialogSeverity, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import type { ServicesAccessor } from "../../../../../platform/instantiation/common/instantiation.js";
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IChatService } from "../../../../services/chat/common/chatService.js";
import type { ModelProviderCredentialStatus } from '../../../../services/chat/common/chatService.js';
import { IPreferencesService } from "../../../../services/preferences/common/preferences.js";
import { IViewsService } from "../../../../services/views/browser/viewsService.js";
import { ChatSessionInspectorVisibleContext, CHAT_VIEW_ID, MOVE_CHAT_TO_EDITOR_COMMAND_ID, MOVE_CHAT_TO_NEW_WINDOW_COMMAND_ID, OPEN_CHAT_BROWSER_COMMAND_ID, OPEN_CHAT_SETTINGS_COMMAND_ID, TOGGLE_SESSION_INSPECTOR_COMMAND_ID } from "../../common/chat.js";
import { ChatViewPane } from "../widgetHosts/viewPane/chatViewPane.js";

const ChatBrowserAvailable = ContextKeyExpr.equals("chatBrowserAvailable", true);
const ChatEditorAreaAvailable = ContextKeyExpr.equals("chatEditorAreaAvailable", true);
const ChatNewWindowAvailable = ContextKeyExpr.equals("chatNewWindowAvailable", true);

registerAction2(class ToggleSessionInspectorAction extends Action2 {
	constructor() {
		super({
			id: TOGGLE_SESSION_INSPECTOR_COMMAND_ID,
			title: "Show Session Inspector",
			tooltip: "Show Session Inspector",
			icon: Lxicon.layoutSidebarRightOff,
			toggled: {
				condition: ChatSessionInspectorVisibleContext.isEqualTo(true),
				title: "Hide Session Inspector",
				tooltip: "Hide Session Inspector",
				icon: Lxicon.layoutSidebarRight,
			},
			menu: [
				{
					id: MenuId.ChatTitleLayout,
					group: "navigation",
					order: 1,
				},
			],
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): void {
		const view = accessor.get(IViewsService).openView(CHAT_VIEW_ID);
		if (view instanceof ChatViewPane) view.toggleInspector();
	}
});

registerAction2(class OpenChatBrowserAction extends Action2 {
	constructor() {
		super({
			id: OPEN_CHAT_BROWSER_COMMAND_ID,
			title: "Open Browser",
			icon: Lxicon.browserWeb,
			precondition: ChatBrowserAvailable,
			menu: {
				id: MenuId.ChatTitle,
				group: "chatActions",
				order: 1,
			},
		});
	}

	override run(): never {
		throw new Error("Open Browser is not available in this build.");
	}
});

registerAction2(class MoveChatToEditorAction extends Action2 {
	constructor() {
		super({
			id: MOVE_CHAT_TO_EDITOR_COMMAND_ID,
			title: "Move Chat to Editor Area",
			icon: Lxicon.layoutPanel,
			precondition: ChatEditorAreaAvailable,
			menu: {
				id: MenuId.ChatTitle,
				group: "chatActions",
				order: 2,
			},
		});
	}

	override run(): never {
		throw new Error("Moving Chat to the Editor Area is not available in this build.");
	}
});

registerAction2(class MoveChatToNewWindowAction extends Action2 {
	constructor() {
		super({
			id: MOVE_CHAT_TO_NEW_WINDOW_COMMAND_ID,
			title: "Move Chat to New Window",
			icon: Lxicon.linkExternal,
			precondition: ChatNewWindowAvailable,
			menu: {
				id: MenuId.ChatTitle,
				group: "chatActions",
				order: 3,
			},
		});
	}

	override run(): never {
		throw new Error("Moving Chat to a New Window is not available in this build.");
	}
});

registerAction2(class OpenChatSettingsAction extends Action2 {
	constructor() {
		super({
			id: OPEN_CHAT_SETTINGS_COMMAND_ID,
			title: "Chat Settings",
			icon: Lxicon.settings,
			menu: {
				id: MenuId.ChatTitle,
				group: "chatActions",
				order: 4,
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const chat = accessor.get(IChatService);
		const preferences = accessor.get(IPreferencesService);
		const quickInput = accessor.get(IQuickInputService);
		const [current, models] = await Promise.all([chat.readAdvisorDefault(), chat.listAdvisorModels()]);
		type Setting = { label: string; description?: string; model?: NonNullable<typeof current>; openSettings?: true; manageProviderKeys?: true; clearModel?: true };
		const picker = quickInput.createQuickPick<Setting>();
		const disposables = new DisposableStore();
		disposables.add(picker);
		picker.ariaLabel = localize('chat.settings.advisorAria', 'Chat settings and advisor model');
		picker.placeholder = models.length
			? localize('chat.settings.advisorPlaceholder', 'Choose an advisor model or open all settings')
			: localize('chat.settings.advisorProviderRequired', 'Configure a provider in Chat Settings to choose an advisor model');
		picker.items = [
			{ label: localize('chat.settings.openAll', 'Open all settings'), openSettings: true },
			{ label: localize('chat.providerKeys.manage', 'Manage Model API Keys'), manageProviderKeys: true },
			...(current ? [{
				label: current.enabled ? localize('chat.settings.advisorDisable', 'Turn Advisor off') : localize('chat.settings.advisorEnable', 'Turn Advisor on'),
				description: `${current.model.provider}/${current.model.model}`,
				model: { ...current, enabled: !current.enabled },
			}, {
				label: localize('chat.settings.advisorClear', 'Clear saved Advisor model'),
				clearModel: true as const,
			}] : []),
			...models.map(entry => ({
				label: entry.displayName,
				description: current?.model.provider === entry.model.provider && current.model.model === entry.model.model ? localize('chat.settings.current', 'Current') : `${entry.model.provider}/${entry.model.model}`,
				model: current?.model.provider === entry.model.provider && current.model.model === entry.model.model
					? { ...current, enabled: true }
					: { model: entry.model, enabled: true, maxCalls: 3, maxOutputTokens: 2048 },
			})),
		];
		disposables.add(picker.onDidAccept((item) => {
			if (item.openSettings) {
				picker.hide();
				void preferences.openSettings();
				return;
			}
			if (item.manageProviderKeys) {
				picker.hide();
				void showModelProviderKeys(chat, quickInput, accessor.get(IDialogService));
				return;
			}
			if (item.clearModel) {
				void chat.saveAdvisorDefault(null).then(
					() => picker.hide(),
					error => { picker.placeholder = `${localize('chat.settings.advisorSaveFailed', 'Could not save advisor model')}: ${String(error)}`; },
				);
				return;
			}
			if (!item.model) return;
			void chat.saveAdvisorDefault(item.model).then(
				() => picker.hide(),
				error => { picker.placeholder = `${localize('chat.settings.advisorSaveFailed', 'Could not save advisor model')}: ${String(error)}`; },
			);
		}));
		disposables.add(picker.onDidHide(() => disposables.dispose()));
		picker.show();
	}
});

interface ModelProviderQuickPickItem extends IQuickPickItem {
	readonly provider: ModelProviderCredentialStatus;
}

async function showModelProviderKeys(chat: IChatService, quickInput: IQuickInputService, dialogs: IDialogService): Promise<void> {
	let providers: readonly ModelProviderCredentialStatus[];
	try {
		providers = (await chat.listModelProviders()).filter(provider => provider.apiKeyPolicy !== 'unsupported');
	} catch {
		await dialogs.showMessage({ severity: DialogSeverity.Error, message: localize('chat.providerKeys.listFailed', 'Could not load model providers') });
		return;
	}
	if (providers.length === 0) {
		await dialogs.showMessage({ severity: DialogSeverity.Info, message: localize('chat.providerKeys.none', 'No model providers accept API keys') });
		return;
	}

	const provider = await pickModelProvider(quickInput, providers);
	if (!provider) return;
	const apiKey = await quickInput.input({
		title: localize('chat.providerKeys.inputTitle', 'API key for {0}', provider.displayName),
		placeHolder: localize('chat.providerKeys.inputPlaceholder', 'Paste an API key'),
		password: true,
		validateInput: async value => value.trim() ? undefined : localize('chat.providerKeys.required', 'Enter an API key'),
	});
	if (apiKey === undefined) return;
	try {
		await chat.setModelProviderApiKey(provider.provider, apiKey.trim());
	} catch {
		await dialogs.showMessage({ severity: DialogSeverity.Error, message: localize('chat.providerKeys.saveFailed', 'Could not save the API key') });
		return;
	}
	try {
		await chat.refreshModels();
	} catch {
		await dialogs.showMessage({ severity: DialogSeverity.Warning, message: localize('chat.providerKeys.refreshFailed', 'API key saved, but models could not be refreshed') });
		return;
	}
	await dialogs.showMessage({ severity: DialogSeverity.Info, message: localize('chat.providerKeys.saved', 'API key saved for {0}', provider.displayName) });
}

function pickModelProvider(quickInput: IQuickInputService, providers: readonly ModelProviderCredentialStatus[]): Promise<ModelProviderCredentialStatus | undefined> {
	const picker = quickInput.createQuickPick<ModelProviderQuickPickItem>();
	const disposables = new DisposableStore();
	disposables.add(picker);
	picker.ariaLabel = localize('chat.providerKeys.aria', 'Model provider API keys');
	picker.placeholder = localize('chat.providerKeys.select', 'Choose a provider to enter or replace its API key');
	picker.items = providers.map(provider => {
		let description: string;
		if (provider.apiKeyConfigured) {
			description = localize('chat.providerKeys.configured', 'API key saved');
		} else if (provider.apiKeyPolicy === 'required') {
			description = localize('chat.providerKeys.missing', 'API key required');
		} else {
			description = localize('chat.providerKeys.optional', 'No API key saved');
		}
		return { provider, label: provider.displayName, description };
	});
	return new Promise(resolve => {
		let settled = false;
		const finish = (provider: ModelProviderCredentialStatus | undefined): void => {
			if (settled) return;
			settled = true;
			picker.hide();
			disposables.dispose();
			resolve(provider);
		};
		disposables.add(picker.onDidAccept(item => finish(item.provider)));
		disposables.add(picker.onDidHide(() => finish(undefined)));
		picker.show();
	});
}
