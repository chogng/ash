import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { extUri } from '../../../../../base/common/resources.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IAgentSessionService } from '../../../../../platform/agentHost/common/agentService.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ResourceContext } from '../../../../common/contextkeys.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import { getPromptFileType, PromptsType } from '../../common/promptSyntax/promptTypes.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IPreferencesService } from '../../../../services/preferences/common/preferences.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';

/** Opens the existing role catalog controls in the current product's Settings host. */
export function registerAgentActions(): DisposableStore {
	const registrations = new DisposableStore();
	registrations.add(registerAction2(class extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.configure.customagents',
				title: localize2('prompt.configure.agents', 'Chat: Configure Custom Agents…'),
				f1: true,
				precondition: ChatContextKeys.enabled.isEqualTo(true),
			});
		}
		public override async run(accessor: ServicesAccessor): Promise<void> {
			if (accessor.get(IConfigurationService).getValue<boolean>(ChatAIDisabledSettingId)) return;
			await accessor.get(IPreferencesService).openSettings({ section: 'agents', jsonEditor: false });
		}
	}));
	registrations.add(registerAction2(class extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.newWithCurrentAgent',
				title: localize2('prompt.agent.newChat', 'Chat: New Chat with Current Agent'),
				f1: true, icon: Lxicon.add,
				precondition: ChatContextKeys.enabled.isEqualTo(true),
				menu: { id: MenuId.EditorTitle, group: 'navigation', order: 5, when: ContextKeyExpr.regex(ResourceContext.key, /\/\.ash\/agents\/[^/]+\.md$/u) },
			});
		}
		public override async run(accessor: ServicesAccessor, expectedResource?: unknown): Promise<void> {
			const configuration = accessor.get(IConfigurationService);
			if (configuration.getValue<boolean>(ChatAIDisabledSettingId)) return;
			const editors = accessor.get(IEditorService);
			const editor = editors.activeEditor;
			const resource = editor?.resource;
			if (!resource || (typeof expectedResource === 'string' && resource.toString() !== expectedResource) || getPromptFileType(resource) !== PromptsType.agent) return;
			const copies = accessor.get(IWorkingCopyService);
			const notifications = accessor.get(INotificationService);
			const navigation = accessor.get(IChatSessionNavigationService);
			const agents = accessor.get(IAgentSessionService);
			const clean = (): boolean => !copies.get(resource).some(copy => copy.isDirty);
			if (!clean()) {
				notifications.info(localize('prompt.agent.saveFirst', 'Save this Agent definition before starting a new chat.'));
				return;
			}
			const revision = navigation.revision;
			const catalog = await agents.readRoleCatalog();
			if (editors.activeEditor !== editor || revision !== navigation.revision || !clean() || configuration.getValue<boolean>(ChatAIDisabledSettingId)) throw new CancellationError();
			const role = catalog.agents.find(candidate => candidate.resource && extUri.isEqual(candidate.resource, resource)
				&& candidate.source.type === 'directory' && (candidate.launch === 'any' || candidate.launch === 'host'));
			if (!role || role.source.type !== 'directory') {
				notifications.info(localize('prompt.agent.unavailable', 'This Agent is unavailable for a new chat. Check its saved definition and host.'));
				return;
			}
			await navigation.createNewConversation({ focus: true, ...(catalog.providerId ? { providerId: catalog.providerId } : {}), agent: { name: role.name, description: role.description, sourceId: role.source.id } });
		}
	}));
	return registrations;
}
