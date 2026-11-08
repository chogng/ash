import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IAppServerApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INetworkDiagnosticsService } from '../../../../../platform/networkDiagnostics/common/networkDiagnosticsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IUntitledTextEditorService } from '../../../../services/untitled/common/untitledTextEditorService.js';
import { UntitledTextEditorInput } from '../../../../services/untitled/common/untitledTextEditorInput.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';

export function registerNetworkDiagnosticsAction(): void {
	registerAction2(NetworkDiagnosticsAction);
}

class NetworkDiagnosticsAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.agentHostNetworkDiagnostics',
			title: localize2('chat.developer.networkDiagnostics', 'Network Diagnostics'),
			category: localize2('debugLogs.developer', 'Developer'),
			f1: true,
			precondition: ChatContextKeys.enabled.isEqualTo(true),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const configuration = accessor.get(IConfigurationService);
		if (configuration.getValue<boolean>(ChatAIDisabledSettingId)) {
			return;
		}
		const appServer = accessor.get(IAppServerApi);
		const network = accessor.get(INetworkDiagnosticsService);
		const editors = accessor.get(IEditorService);
		const untitled = accessor.get(IUntitledTextEditorService);
		const generation = appServer.connectionGeneration;
		const report = await network.run();
		const state = await appServer.getConnectionState();
		if (state !== 'ready' || generation !== appServer.connectionGeneration || configuration.getValue<boolean>(ChatAIDisabledSettingId)) {
			return;
		}
		const heading = localize('chat.developer.networkDiagnostics', 'Network Diagnostics');
		const explanation = localize('chat.developer.networkReport', 'Configured service targets, connection routes, and reachability checks from this window’s App Server.');
		const initialValue = `# ${heading}\n\n${explanation}\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;
		const model = untitled.create({ label: heading, initialValue, languageId: 'markdown' });
		await editors.openEditor(new UntitledTextEditorInput(model), { pinned: true });
	}
}
