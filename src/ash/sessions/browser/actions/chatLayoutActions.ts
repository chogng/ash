import { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';
import { Schemas } from '../../../base/common/network.js';
import { ChatContextKeys } from '../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { IEditorGroupsService } from '../../../workbench/services/editor/common/editorGroupsService.js';
import { ILanguageModelsService } from '../../../workbench/contrib/chat/common/languageModels.js';
import { Lxicon } from "../../../base/common/lxicons.js";
import { DisposableStore } from "../../../base/common/lifecycle.js";
import { localize, localize2 } from "../../../nls.js";
import { Action2, MenuId, MenusRegistry, registerAction2 } from "../../../platform/actions/common/actions.js";
import { ContextKeyExpr } from "../../../platform/contextkey/common/contextkey.js";
import { DialogSeverity, IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import type { ServicesAccessor } from "../../../platform/instantiation/common/instantiation.js";
import { IQuickInputService, type IQuickPickItem } from '../../../platform/quickinput/common/quickInput.js';
import { IChatService } from "../../../workbench/services/chat/common/chatService.js";
import type { ModelProviderCredentialStatus } from '../../../workbench/services/chat/common/chatService.js';
import { IPreferencesService } from "../../../workbench/services/preferences/common/preferences.js";
import { IViewsService } from "../../../workbench/services/views/common/viewsService.js";
import { AGENT_SESSIONS_ORIENTATION_SETTING, AgentSessionsOrientation, AgentSessionsOrientationContext, AgentSessionsSidebarVisibleContext, CHAT_VIEW_ID, MOVE_CHAT_TO_EDITOR_COMMAND_ID, MOVE_CHAT_TO_NEW_WINDOW_COMMAND_ID, OPEN_CHAT_BROWSER_COMMAND_ID, OPEN_CHAT_SETTINGS_COMMAND_ID, TOGGLE_AGENT_SESSIONS_SIDEBAR_COMMAND_ID } from "../../../workbench/contrib/chat/common/chat.js";
import { ChatViewPane } from "../chatViewPane.js";
import { Menus } from '../menus.js';
import { ConfigurationTarget, IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../platform/registry/common/platform.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<AgentSessionsOrientation>({
	key: AGENT_SESSIONS_ORIENTATION_SETTING,
	defaultValue: AgentSessionsOrientation.SideBySide,
	scope: ConfigurationScope.WINDOW,
	schema: { type: 'string', enum: Object.values(AgentSessionsOrientation) },
	parse(value: unknown): AgentSessionsOrientation {
		switch (value) {
			// Decode old profiles until Chat migrates the persisted value to a fixed layout.
			case 'auto': return AgentSessionsOrientation.SideBySide;
			case AgentSessionsOrientation.SideBySide:
			case AgentSessionsOrientation.Stacked: return value;
			default: throw new TypeError(localize('chat.sessions.layout.invalid', 'Invalid Sessions layout.'));
		}
	},
	setting: {
		title: localize('chat.sessions.layout.title', 'Sessions layout'),
		description: localize('chat.sessions.layout.description', 'Choose Side by side or Stacked for the Sessions list. Your choice is remembered and does not change when you resize Chat. Use the Sessions button to open or close the list.'),
		valueType: 'select',
		options: [
			{ value: AgentSessionsOrientation.SideBySide, label: localize('chat.sessions.layout.sideBySide', 'Side by side') },
			{ value: AgentSessionsOrientation.Stacked, label: localize('chat.sessions.layout.stacked', 'Stacked') },
		],
	},
});

MenusRegistry.appendMenuItem(MenuId.ChatTitle, {
	submenu: Menus.ChatSessionsLayout,
	title: localize2('chat.sessions.layout.title', 'Sessions layout'),
	group: 'layout',
	order: 1,
});

for (const [orientation, title, id] of [
	[AgentSessionsOrientation.SideBySide, localize2('chat.sessions.layout.sideBySide', 'Side by side'), 'workbench.action.chat.setAgentSessionsOrientationSideBySide'],
	[AgentSessionsOrientation.Stacked, localize2('chat.sessions.layout.stacked', 'Stacked'), 'workbench.action.chat.setAgentSessionsOrientationStacked'],
] as const) {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id,
				title,
				toggled: AgentSessionsOrientationContext.isEqualTo(orientation),
				menu: { id: Menus.ChatSessionsLayout, group: 'navigation' },
				f1: true,
			});
		}
		override async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IConfigurationService).updateValue(AGENT_SESSIONS_ORIENTATION_SETTING, orientation, ConfigurationTarget.USER_LOCAL);
		}
	});
}

const ChatBrowserAvailable = ContextKeyExpr.equals("chatBrowserAvailable", true);

const ChatNewWindowAvailable = ContextKeyExpr.equals("chatNewWindowAvailable", true);

registerAction2(class ToggleAgentSessionsSidebarAction extends Action2 {
	constructor() {
		super({
			id: TOGGLE_AGENT_SESSIONS_SIDEBAR_COMMAND_ID,
			title: localize2('chat.sessions.showSidebar', 'Show Agent Sessions'),
			tooltip: localize('chat.sessions.showSidebar', 'Show Agent Sessions'),
			icon: Lxicon.layoutSidebarRightOff1,
			toggled: {
				condition: AgentSessionsSidebarVisibleContext.isEqualTo(true),
				title: localize('chat.sessions.hideSidebar', 'Hide Agent Sessions'),
				tooltip: localize('chat.sessions.hideSidebar', 'Hide Agent Sessions'),
				icon: Lxicon.layoutSidebarRight1,
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

	override async run(accessor: ServicesAccessor): Promise<void> {
		const view = await accessor.get(IViewsService).openView(CHAT_VIEW_ID);
		if (view instanceof ChatViewPane) view.toggleSessionsSidebar();
	}
});

registerAction2(class OpenChatBrowserAction extends Action2 {
	constructor() {
		super({
			id: OPEN_CHAT_BROWSER_COMMAND_ID,
			title: localize2({ bundle: 'ash.sessions', key: 'command.OpenChatBrowserAction' }, "Open Browser"),
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
			title: localize2({ bundle: 'ash.sessions', key: 'command.MoveChatToEditorAction' }, "Move Chat to Editor Area"),
			icon: Lxicon.layoutPanel1,
			precondition: ContextKeyExpr.and(ChatContextKeys.enabled.isEqualTo(true), ContextKeyExpr.not('chatInEditor')),
			f1: true,
			menu: {
				id: MenuId.ChatTitle,
				group: "chatActions",
				order: 2,
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const view = await accessor.get(IViewsService).openView(CHAT_VIEW_ID);
		if (view instanceof ChatViewPane) await view.moveToEditor();
	}
});

registerAction2(class MoveChatToSidebarAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.moveToSideBar',
			title: localize2('chat.moveToSidebar', 'Move Chat to Side Bar'),
			precondition: ContextKeyExpr.equals('chatInEditor', true),
			f1: true,
			menu: { id: MenuId.ChatTitle, group: 'chatActions', order: 2, when: ContextKeyExpr.equals('chatInEditor', true) },
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const sessions = accessor.get(ISessionsManagementService);
		const revision = sessions.navigationRevision;
		const view = accessor.get(IViewsService).getViewWithId(CHAT_VIEW_ID);
		if (view instanceof ChatViewPane) await view.captureActiveDraft();
		if (revision !== sessions.navigationRevision) return;
		for (const group of accessor.get(IEditorGroupsService).groups) {
			for (const input of [...group.inputs]) {
				if (input.resource.scheme === Schemas.vscodeChatEditor) await group.closeEditor(input);
			}
		}
		await accessor.get(IViewsService).focusView(CHAT_VIEW_ID);
	}
});

registerAction2(class MoveChatToNewWindowAction extends Action2 {
	constructor() {
		super({
			id: MOVE_CHAT_TO_NEW_WINDOW_COMMAND_ID,
			title: localize2({ bundle: 'ash.sessions', key: 'command.MoveChatToNewWindowAction' }, "Move Chat to New Window"),
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
			title: localize2({ bundle: 'ash.sessions', key: 'command.OpenChatSettingsAction' }, "Chat Settings"),
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
		const quickInput = accessor.get(IQuickInputService);
		const [current, models] = await Promise.all([chat.readAdvisorDefault(), accessor.get(ILanguageModelsService).listAdvisorModels()]);
		type Setting = { label: string; description?: string; model?: NonNullable<typeof current>; openSettings?: true; manageProviderKeys?: true; clearModel?: true; };
		const picker = quickInput.createQuickPick<Setting>();
		const disposables = new DisposableStore();
		disposables.add(picker);
		picker.ariaLabel = localize('chat.settings.advisorAria', 'Chat settings and advisor model');
		picker.placeholder = models.length
			? localize('chat.settings.advisorPlaceholder', 'Choose an advisor model or open all settings')
			: localize('chat.settings.advisorProviderRequired', 'Configure a provider in Chat Settings to choose an advisor model');
		picker.items = [
			{ label: localize('chat.settings.openAll', 'Open all settings'), openSettings: true },
			{ label: localize('chat.providerKeys.manage', 'Manage Model Connections'), manageProviderKeys: true },
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
		disposables.add(picker.onDidAccept(() => {
			const item = picker.selectedItems[0];
			if (!item) return;

			if (item.openSettings) {
				picker.hide();
				void accessor.get(IPreferencesService).openSettings();
				return;
			}
			if (item.manageProviderKeys) {
				picker.hide();
				void showModelProviderKeys(accessor.get(ILanguageModelsService), quickInput, accessor.get(IDialogService));
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

async function showModelProviderKeys(chat: ILanguageModelsService, quickInput: IQuickInputService, dialogs: IDialogService): Promise<void> {
	let providers: readonly ModelProviderCredentialStatus[];
	try {
		providers = await chat.listModelProviders();
	} catch {
		await dialogs.showMessage({ severity: DialogSeverity.Error, message: localize('chat.providerKeys.listFailed', 'Could not load model providers') });
		return;
	}
	if (providers.length === 0) {
		await dialogs.showMessage({ severity: DialogSeverity.Info, message: localize('chat.providerKeys.none', 'No model providers accept API keys') });
		return;
	}

	const choice = await pickModelProvider(quickInput, providers);
	if (!choice) return;
	const { provider } = choice;
	const apiKey = await quickInput.input({
		title: localize('chat.providerKeys.inputTitle', 'API key for {0}', provider.displayName),
		placeHolder: localize('chat.providerKeys.inputPlaceholder', 'Paste an API key'),
		password: true,
		validateInput: async value => value.trim() ? undefined : localize('chat.providerKeys.required', 'Enter an API key'),
	});
	if (apiKey === undefined) return;
	try {
		await chat.setModelProviderApiKey(provider.connection, apiKey.trim());
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

function pickModelProvider(quickInput: IQuickInputService, providers: readonly ModelProviderCredentialStatus[]): Promise<ModelProviderQuickPickItem | undefined> {
	const picker = quickInput.createQuickPick<ModelProviderQuickPickItem>();
	const disposables = new DisposableStore();
	disposables.add(picker);
	picker.ariaLabel = localize('chat.connections.aria', 'Model connections');
	picker.placeholder = localize('chat.connections.select', 'Choose a connection to save an API key.');
	picker.items = providers.flatMap(provider => {
		let description: string;
		if (provider.apiKeyConfigured) {
			description = localize('chat.providerKeys.configured', 'API key saved');
		} else if (provider.apiKeyPolicy === 'required') {
			description = localize('chat.providerKeys.missing', 'API key required');
		} else {
			description = localize('chat.providerKeys.optional', 'No API key saved');
		}
		const items: ModelProviderQuickPickItem[] = [];
		if (provider.apiKeyPolicy !== 'unsupported') items.push({
			provider,
			label: localize('chat.connections.saveKey', 'Save key for {0}', provider.displayName), description
		});
		return items;
	});
	return new Promise(resolve => {
		let settled = false;
		const finish = (provider: ModelProviderQuickPickItem | undefined): void => {
			if (settled) return;
			settled = true;
			picker.hide();
			disposables.dispose();
			resolve(provider);
		};
		disposables.add(picker.onDidAccept(() => {
			const item = picker.selectedItems[0];
			if (!item) return;
			return finish(item);
		}));
		disposables.add(picker.onDidHide(() => finish(undefined)));
		picker.show();
	});
}
