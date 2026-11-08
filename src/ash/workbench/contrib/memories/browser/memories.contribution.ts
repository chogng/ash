import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';
import { IMemorySettingsNavigation, MEMORIES_FOCUS_CONTEXT, MemorySettingsNavigation, OPEN_MEMORIES_COMMAND_ID } from './memorySettings.js';
import { localize, localize2 } from '../../../../nls.js';
import { ContextKeyExpr, IContextKeyService, type ContextKeyExpression } from '../../../../platform/contextkey/common/contextkey.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IMemoriesService } from '../../../../platform/memories/common/memoriesService.js';
import { type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IChatSessionNavigationService } from '../../../services/chat/common/chatSessionNavigationService.js';
import { ChatRequestActionContext } from '../../chat/browser/chat.js';
import { ChatContextKeys } from '../../chat/common/actions/chatContextKeys.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'accessibility.verbosity.memories', defaultValue: true,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError('Memories accessibility verbosity must be boolean'); } return value; },
	setting: { valueType: 'boolean', get title() { return localize({ bundle: 'ash.settings', key: 'memory.verbosityTitle' }, 'Memory settings accessibility help'); }, get description() { return localize({ bundle: 'ash.settings', key: 'memory.verbosityDescription' }, 'Announce how to open keyboard help when Memory settings receives focus.'); } },
});

registerSingleton(IMemorySettingsNavigation, MemorySettingsNavigation, InstantiationType.Delayed);

export function registerMemoryManagement(chatMode?: ContextKeyExpression): void {
	registerWorkbenchContribution('workbench.contrib.memories', WorkbenchPhase.BlockStartup, accessor => {
		const registrations = new DisposableStore();
		if (!accessor.getOptional(IMemoriesService)) { return registrations; }
		const namespace = (services: ServicesAccessor) =>
			chatMode && services.get(IContextKeyService).contextMatchesRules(chatMode) ? 'chat' : 'code';
		registrations.add(registerAction2(class OpenMemories extends Action2 {
			constructor() { super({ id: OPEN_MEMORIES_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.OpenMemories' }, 'Open memories'), f1: true }); }
			public override run(services: ServicesAccessor): Promise<void> {
				return services.get(IMemorySettingsNavigation).open(services.get(IPreferencesService));
			}
		}));
		registrations.add(registerAction2(class SaveMemory extends Action2 {
			constructor() { super({ id: 'ash.memories.save', title: localize2({ bundle: 'ash.workbench', key: 'command.SaveMemory' }, 'Save memory'), keybinding: { primary: Keybinding.single(logicalKey('s', { primaryKey: true })), when: ContextKeyExpr.has(MEMORIES_FOCUS_CONTEXT), priority: 1000 } }); }
			public override run(services: ServicesAccessor): Promise<void> { return services.get(IMemorySettingsNavigation).save(); }
		}));
		registrations.add(registerAction2(class SaveProjectMemoryFromMessage extends Action2 {
			constructor() {
				super({
					id: 'ash.memories.fromMessage',
					title: localize2('chat.message.saveProjectMemory', 'Save as project memory'),
					menu: {
						id: MenuId.ChatMessageTitle,
						group: 'memory',
						when: ContextKeyExpr.and(ChatContextKeys.requestCanEdit.isEqualTo(true), ChatContextKeys.requestHasText.isEqualTo(true)),
					},
				});
			}
			public override async run(services: ServicesAccessor, context: unknown): Promise<void> {
				if (!(context instanceof ChatRequestActionContext) || !context.visible) { return; }
				const { requestSource, text } = context.item;
				if (!requestSource || !text?.trim()) { return; }
				const { sessionId, threadId, turnId, itemId } = requestSource;
				const navigation = services.get(IChatSessionNavigationService);
				const preferences = services.get(IPreferencesService);
				const settings = services.get(IMemorySettingsNavigation);
				const kind = namespace(services);
				let origin = { sessionId, threadId, turnId, itemId };
				if (navigation.prepareConversationLink) {
					const address = await navigation.prepareConversationLink(sessionId, threadId);
					if (address.connectionAuthority !== 'local') {
						throw new Error(localize('memories.localConversationRequired', 'Project memories are available for conversations on this host.'));
					}
					origin = { sessionId: address.sessionId, threadId: address.threadId, turnId, itemId };
				}
				if (!navigation.getConversations().some(conversation =>
					conversation.kind === kind
					&& (conversation.sessionId === sessionId && conversation.threadId === threadId
						|| conversation.sessionId === origin.sessionId && conversation.threadId === origin.threadId))) {
					throw new Error(localize('memories.modeConversationRequired', 'Open a conversation in this mode to save a project memory.'));
				}
				await settings.open(preferences, { kind: 'draft', origin, text });
			}
		}));
		registrations.add(registerAction2(class OpenMemoryReference extends Action2 {
			constructor() { super({ id: 'ash.memories.openReference', title: localize2({ bundle: 'ash.workbench', key: 'command.OpenMemoryReference' }, 'Open memory reference') }); }
			public override run(services: ServicesAccessor, reference: string): Promise<void> {
				return services.get(IMemorySettingsNavigation).open(services.get(IPreferencesService), { kind: 'reference', reference });
			}
		}));
		return registrations;
	});
}
