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
import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { ChatGPTEditorPane } from './chatGPTEditor.js';
import { IChatGPTTransport } from '../common/chatGPTTransport.js';
import { ElectronChatGPTTransport } from '../electron-browser/electronChatGPTTransport.js';
import { ChatGPTWebContribution, chatGPTScrollOptimization } from './chatGPTWeb.js';
import { ChatGPTService, IChatGPTService, chatGPTNavigationContainerId } from './chatGPTService.js';
import { ChatGPTNavigationView } from './chatGPTNavigationView.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewContainerLocation } from '../../../../workbench/common/views.js';
import { SessionsViewRegistry } from '../../../common/views.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { getActiveElement } from '../../../../base/browser/dom.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';

registerSingleton(IChatGPTService, ChatGPTService, InstantiationType.Delayed);
registerSingleton(IChatGPTTransport, ElectronChatGPTTransport, InstantiationType.Delayed);
registerEditorPane({ id: 'sessions.editor.chatgpt', name: 'ChatGPT', canOpen: input => input.resource.scheme === 'ash-chatgpt' ? EditorPaneMatch.Default : EditorPaneMatch.None, create: options => options.instantiationService!.createInstance(ChatGPTEditorPane) });
SessionsViewRegistry.registerViewContainer({
	id: chatGPTNavigationContainerId, title: 'ChatGPT', localizationKey: { bundle: 'ash', key: 'sessions.chatgpt.title' }, location: ViewContainerLocation.Sidebar, order: 2,
});
SessionsViewRegistry.registerViews(chatGPTNavigationContainerId, [{
	id: `${chatGPTNavigationContainerId}.view`, title: 'ChatGPT', localizationKey: { bundle: 'ash', key: 'sessions.chatgpt.title' }, ctorDescriptor: new SyncDescriptor(ChatGPTNavigationView), canToggleVisibility: false,
}]);

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

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type, priority: 100, name: `sessionsChatGPT${type}`, when: ContextKeyExpr.has('chatGPTFocused'),
		getProvider: accessor => {
			const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
			const chat = accessor.get(IChatGPTService);
			return new AccessibleContentProvider(AccessibleViewProviderId.ChatGPT, { type }, () => type === AccessibleViewType.Help
				? localize('sessions.chatgpt.navigationHelp', 'ChatGPT conversations are in the window sidebar. Use Tab to reach New chat, search, the conversation list and Load more. Arrow keys, Home and End move within the list; Enter opens a conversation. Search filters loaded conversations. Accessibility commands open help and a selectable text view of the current chat; closing the view returns focus here. Enter sends a message; Shift+Enter inserts a line break. Select Stop to interrupt a reply. Login is managed externally. Reload ChatGPT from the activity icon context menu to refresh its content. Drafts are retained when switching conversations. Use window separators to resize the sidebar and the title bar to show or hide it.')
				+ '\n\n' + localize('sessions.chatgpt.inputHelp', 'The message input starts with one line and grows as you type. Use Tab and Shift+Tab to reach Attach files, the message, model, Dictate message and Send or Stop. Choose files with Attach files, or paste and drop files into the input. Attachments show upload status; failed uploads offer Retry and all attachments offer Remove. Sending waits until every attachment is ready. Files can be sent without text. The rightmost button starts voice conversation when the draft is empty, sends when there is text or an attachment, and stops the current reply or voice conversation. Voice uses the microphone and plays replies; leaving ChatGPT or switching conversations stops voice. Dictation inserts completed phrases at the cursor without sending. Select Stop dictation to finish or press Escape to discard unfinished speech. Switching conversations or leaving ChatGPT cancels dictation. While loading, replying or in voice conversation, the message input is read-only.')
				+ '\n\n' + localize('sessions.chatgpt.richContentHelp', 'Press Enter on a citation number to expand source details. Media provides playback controls; attachments can be previewed, opened or downloaded here. Use Tab to move between interactive preview controls. Charts support type, zoom and series controls; focus a chart and use Left and Right Arrow to read data points.')
				: chat.getAccessibleContent(), () => focused?.focus(), AccessibilityVerbositySettingId.ChatGPT);
		},
	});
}

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
			toggled: ContextKeyExpr.has('sessions.activity.chatgptSelected'),
			menu: { id: Menus.ActivityBar, group: 'navigation', order: 25 }, f1: true,
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
			menu: { id: Menus.ActivityBarContext, when: ActivityBarItemContext.isEqualTo('sessions.open.chatgpt'), group: 'navigation' },
			f1: true,
		});
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IChatGPTService).reload();
	}
});
