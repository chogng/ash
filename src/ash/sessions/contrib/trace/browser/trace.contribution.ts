import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { OpenAgentTraceCommandId } from '../../../../workbench/contrib/trace/common/trace.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';

registerAction2(class OpenAgentTrace extends Action2 {
	constructor() {
		super({
			id: 'sessions.trace.open',
			title: localize2('agentTrace.open', 'View Execution Trace'),
			f1: true,
			icon: Lxicon.history,
			menu: { id: MenuId.ChatTitle, group: 'navigation', order: 3 },
		});
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		const active = accessor.get(ISessionsService).activeSelection;
		const sessionId = active?.kind === 'session' ? active.active.session.sessionId : undefined;
		const commands = accessor.get(ICommandService);
		await commands.executeCommand('sessions.open.code');
		await commands.executeCommand(OpenAgentTraceCommandId, sessionId);
	}
});
