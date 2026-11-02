import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { localize2, localize } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { registerEditorPane } from '../../../browser/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { EditorInputSerializers } from '../../../services/editor/common/editorInputSerializer.js';
import { ChatContextKeys } from '../../chat/common/actions/chatContextKeys.js';
import { AgentSessionsWelcomePage, AgentSessionsWelcomeInputSerializer, getAgentSessionsWelcomePrefillKey } from './agentSessionsWelcome.js';
import { AgentSessionsWelcomeInput } from './agentSessionsWelcomeInput.js';

EditorInputSerializers.registerStatic(new AgentSessionsWelcomeInputSerializer());
registerEditorPane({
	id: AgentSessionsWelcomePage.ID,
	name: localize('agentSessionsWelcome.title', 'Agent Sessions Welcome'),
	canOpen: input => input instanceof AgentSessionsWelcomeInput ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => options.instantiationService!.createInstance(AgentSessionsWelcomePage),
});

registerAction2(class OpenAgentSessionsWelcomeAction extends Action2 {
	constructor() {
		super({
			id: AgentSessionsWelcomePage.COMMAND_ID,
			title: localize2('agentSessionsWelcome.open', 'Open Agent Sessions Welcome'),
			precondition: ChatContextKeys.enabled.isEqualTo(true), f1: true,
		});
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		if (accessor.get(IConfigurationService).getValue<boolean>(ChatAIDisabledSettingId)) { return; }
		await accessor.get(IEditorService).openEditor(new AgentSessionsWelcomeInput());
	}
});

// A requested workspace handoff takes precedence over the ordinary startup-editor preference.
registerWorkbenchContribution('workbench.contrib.agentSessionsWelcomePrefill', WorkbenchPhase.AfterRestored, accessor => {
	const storage = accessor.get(IStorageService);
	const workspace = accessor.get(IWorkspaceContextService);
	const configuration = accessor.get(IConfigurationService);
	const editors = accessor.get(IEditorService);
	const notifications = accessor.get(INotificationService);
	const lifetime = new DisposableStore();
	let retired = false;
	lifetime.add(toDisposable(() => { retired = true; }));
	const open = (): void => {
		const key = getAgentSessionsWelcomePrefillKey(workspace.getWorkspace());
		if (retired || !key || !storage.get(key, StorageScope.APPLICATION) || configuration.getValue<boolean>(ChatAIDisabledSettingId)) { return; }
		void editors.openEditor(new AgentSessionsWelcomeInput()).catch(error => {
			if (!retired) { notifications.error(error instanceof Error ? error : String(error)); }
		});
	};
	open();
	return lifetime;
});
