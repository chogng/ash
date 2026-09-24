import { lxiconsLibrary } from "../../../../../base/common/lxiconsLibrary.js";
import { DisposableStore } from "../../../../../base/common/lifecycle.js";
import { localize } from "../../../../../nls.js";
import { Action2, MenuId, registerAction2 } from "../../../../../platform/actions/common/actions.js";
import { ContextKeyExpr } from "../../../../../platform/contextkey/common/contextkey.js";
import type { ServicesAccessor } from "../../../../../platform/instantiation/common/instantiation.js";
import { IQuickInputService } from "../../../../../platform/quickinput/common/quickInput.js";
import { IChatService } from "../../../../services/chat/common/chatService.js";
import { IPreferencesService } from "../../../../services/preferences/common/preferences.js";
import { IViewsService } from "../../../../services/views/browser/viewsService.js";
import { ChatSessionInspectorVisibleContext, CHAT_VIEW_ID, MOVE_CHAT_TO_EDITOR_COMMAND_ID, MOVE_CHAT_TO_NEW_WINDOW_COMMAND_ID, OPEN_CHAT_BROWSER_COMMAND_ID, OPEN_CHAT_SETTINGS_COMMAND_ID, TOGGLE_SESSION_INSPECTOR_COMMAND_ID } from "../../common/chat.js";
import { ChatViewPane } from "../view/chatViewPane.js";

const ChatBrowserAvailable = ContextKeyExpr.equals("chatBrowserAvailable", true);
const ChatEditorAreaAvailable = ContextKeyExpr.equals("chatEditorAreaAvailable", true);
const ChatNewWindowAvailable = ContextKeyExpr.equals("chatNewWindowAvailable", true);

registerAction2(class ToggleSessionInspectorAction extends Action2 {
	constructor() {
		super({
			id: TOGGLE_SESSION_INSPECTOR_COMMAND_ID,
			title: "Show Session Inspector",
			tooltip: "Show Session Inspector",
			icon: lxiconsLibrary.layoutSidebarRightOff,
			toggled: {
				condition: ChatSessionInspectorVisibleContext.isEqualTo(true),
				title: "Hide Session Inspector",
				tooltip: "Hide Session Inspector",
				icon: lxiconsLibrary.layoutSidebarRight,
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
			icon: lxiconsLibrary.browserWeb,
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
			icon: lxiconsLibrary.layoutPanel,
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
			icon: lxiconsLibrary.linkExternal,
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
			icon: lxiconsLibrary.settings,
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
		const [current, models] = await Promise.all([chat.readAdvisorDefault(), chat.listAdvisorModels()]);
		type Setting = { label: string; description?: string; model?: NonNullable<typeof current>; openSettings?: true; clearModel?: true };
		const picker = accessor.get(IQuickInputService).createQuickPick<Setting>();
		const disposables = new DisposableStore();
		disposables.add(picker);
		picker.ariaLabel = localize('chat.settings.advisorAria', 'Chat settings and advisor model');
		picker.placeholder = models.length
			? localize('chat.settings.advisorPlaceholder', 'Choose an advisor model or open all settings')
			: localize('chat.settings.advisorProviderRequired', 'Configure a provider in Chat Settings to choose an advisor model');
		picker.items = [
			{ label: localize('chat.settings.openAll', 'Open all settings'), openSettings: true },
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
