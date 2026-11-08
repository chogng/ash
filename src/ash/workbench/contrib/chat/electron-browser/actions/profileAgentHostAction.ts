import { localize, localize2 } from '../../../../../nls.js';
import { Action2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { runDiagnostic } from './debugAgentHostAction.js';

export class ProfileAgentHostAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.profileAgentHost',
			title: localize2('chat.developer.startCpuProfile', 'Start Local App Server CPU Recording'),
			category: localize2('debugLogs.developer', 'Developer'),
			f1: true,
			precondition: ChatContextKeys.enabled.isEqualTo(true),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const notifications = accessor.get(INotificationService);
		if (await runDiagnostic(accessor, 'startProfile')) {
			notifications.info(localize('chat.developer.cpuRecordingStarted', 'App Server CPU recording started. Run Stop Local App Server CPU Recording to finish and save the profile.'));
		}
	}
}

export class StopAgentHostProfileAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.stopAgentHostProfile',
			title: localize2('chat.developer.stopCpuProfile', 'Stop Local App Server CPU Recording'),
			category: localize2('debugLogs.developer', 'Developer'),
			f1: true,
			precondition: ChatContextKeys.enabled.isEqualTo(true),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await runDiagnostic(accessor, 'stopProfile');
	}
}
