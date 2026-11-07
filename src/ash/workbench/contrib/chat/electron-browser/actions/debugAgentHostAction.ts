import { localize, localize2 } from '../../../../../nls.js';
import { Action2 } from '../../../../../platform/actions/common/actions.js';
import type { LocalAppServerDiagnosticOperation } from '../../../../../platform/agentHost/common/appServerTransport.js';
import { runLocalAppServerDiagnostic } from '../../../../../platform/agentHost/electron-browser/localAgentHostService.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { getWorkspaceRemoteAuthority, IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';

export class DebugAgentHostInDevToolsAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.debugAgentHostInDevTools',
			title: localize2('chat.developer.debugLocalAppServer', 'Debug Local App Server'),
			category: localize2('debugLogs.developer', 'Developer'),
			f1: true,
			precondition: ChatContextKeys.enabled.isEqualTo(true),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await runDiagnostic(accessor, 'debug');
	}
}

export async function runDiagnostic(accessor: ServicesAccessor, operation: LocalAppServerDiagnosticOperation): Promise<boolean> {
	if (operation !== 'stopProfile' && accessor.get(IConfigurationService).getValue<boolean>(ChatAIDisabledSettingId)) {
		return false;
	}
	if (getWorkspaceRemoteAuthority(accessor.get(IWorkspaceContextService).getWorkspace())) {
		throw new Error(localize('chat.developer.localDiagnosticsOnly', 'Run local App Server process diagnostics from a local desktop window.'));
	}
	await runLocalAppServerDiagnostic(operation);
	return true;
}
