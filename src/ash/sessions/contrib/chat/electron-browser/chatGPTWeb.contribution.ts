import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { Menus } from '../../../browser/menus.js';
import { ActivityBarItemContext } from '../../../common/contextkeys.js';
import { registerChatGPTAccessibility } from './chatGPTAccessibility.js';
import { registerReplyChatEditor } from '../browser/replyChatEditor.js';
import { IChatGPTTransport } from '../../chatgptweb/common/chatGPTTransport.js';
import { ElectronChatGPTTransport } from '../../chatgptweb/electron-browser/electronChatGPTTransport.js';
import { ChatGPTWebContribution, chatGPTReplyEditor, chatGPTScrollOptimization, chatGPTSelectedContext } from './chatGPTWeb.js';
import { ChatGPTService, IChatGPTService } from '../../chatgptweb/browser/chatGPTService.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IAccountService } from '../../../../platform/accounts/common/accountService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProgressService } from '../../../../platform/progress/common/progress.js';
import { signInChatGPT } from '../../chatgptweb/browser/chatGPTLogin.js';

registerSingleton(IChatGPTService, ChatGPTService, InstantiationType.Delayed);
registerSingleton(IChatGPTTransport, ElectronChatGPTTransport, InstantiationType.Delayed);
registerReplyChatEditor(chatGPTReplyEditor);
Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.ChatGPT, defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError('ChatGPT accessibility verbosity must be boolean'); }
		return value;
	},
	setting: {
		valueType: 'boolean', title: localize('sessions.chatgpt.navigationVerbosity', 'ChatGPT accessibility help'),
		description: localize('sessions.chatgpt.navigationVerbosityDescription', 'Announce how to open accessibility help when ChatGPT receives focus.'),
	},
});

registerChatGPTAccessibility(chatGPTReplyEditor.accessibility.focusContext, IChatGPTService);

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: chatGPTScrollOptimization, defaultValue: true, scope: ConfigurationScope.APPLICATION,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError('ChatGPT scrolling optimization must be boolean'); }
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('sessions.chatgpt.optimizeTitle', 'ChatGPT scrolling optimization'); },
		get description() { return localize('sessions.chatgpt.optimizeDescription', 'Experimentally skip offscreen rendering of completed ChatGPT replies. Turn off if scrolling or page content behaves unexpectedly.'); },
	},
});

registerWorkbenchContribution(ChatGPTWebContribution.ID, WorkbenchPhase.BlockRestore,
	services => services.get(IInstantiationService).createInstance(ChatGPTWebContribution));

registerAction2(class OpenChatGPT extends Action2 {
	constructor() {
		super({
			id: 'sessions.open.chatgpt', title: localize2('sessions.chatgpt.title', 'ChatGPT'), icon: Lxicon.openai,
			toggled: ContextKeyExpr.has(chatGPTSelectedContext),
			f1: true,
		});
	}
	public override async run(accessor: ServicesAccessor): Promise<void> { await accessor.get(ICommandService).executeCommand('sessions.show.chatgpt'); }
});

registerAction2(class ToggleChatGPTScrolling extends Action2 {
	constructor() {
		super({ id: 'sessions.chatgpt.toggleScrollOptimization', title: localize2('sessions.chatgpt.toggleOptimization', 'ChatGPT: Toggle Scrolling Optimization'), f1: true });
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const configuration = accessor.get(IConfigurationService);
		await configuration.updateValue(chatGPTScrollOptimization, !configuration.getValue<boolean>(chatGPTScrollOptimization));
	}
});

registerAction2(class ReloadChatGPT extends Action2 {
	constructor() {
		super({
			id: 'sessions.chatgpt.reload',
			title: localize2('sessions.chatgpt.reload', 'ChatGPT: Reload'),
			shortTitle: localize2('sessions.chatgpt.reloadShort', 'Reload'),
			menu: { id: Menus.ActivityBarContext, when: ContextKeyExpr.and(ActivityBarItemContext.isEqualTo('sessions.newSession'), ContextKeyExpr.has(chatGPTSelectedContext)), group: 'navigation' },
			f1: true,
		});
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IChatGPTService).reload();
	}
});

const authenticationMenu = {
	id: Menus.ActivityBarContext,
	when: ContextKeyExpr.and(ActivityBarItemContext.isEqualTo('sessions.newSession'), ContextKeyExpr.has(chatGPTSelectedContext)),
	group: 'authentication',
};

registerAction2(class SignInChatGPT extends Action2 {
	constructor() {
		super({ id: 'sessions.chatgpt.signIn', title: localize2('sessions.chatgpt.signIn', 'ChatGPT: Sign In to Ash'), f1: true, menu: authenticationMenu });
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		await signInChatGPT(accessor.get(IAccountService), accessor.get(INotificationService), accessor.get(IProgressService));
	}
});

registerAction2(class UseCodexChatGPTLogin extends Action2 {
	constructor() {
		super({ id: 'sessions.chatgpt.useCodexLogin', title: localize2('sessions.chatgpt.useCodexLogin', 'ChatGPT: Use Codex Login'), f1: true, menu: authenticationMenu });
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IAccountService).startLogin({ type: 'chatGptWebCodex' });
	}
});

registerAction2(class SignOutChatGPT extends Action2 {
	constructor() {
		super({ id: 'sessions.chatgpt.signOut', title: localize2('sessions.chatgpt.signOut', 'ChatGPT: Sign Out of Ash'), f1: true, menu: authenticationMenu });
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IAccountService).logout('chatgpt-web');
	}
});
