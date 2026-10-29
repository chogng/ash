import { localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { type ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerTerminalContribution } from '../../../terminal/browser/terminalExtensions.js';
import { TerminalDictationStateContext, TerminalVoiceContribution } from './terminalVoice.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { InstanceContext } from '../../../terminal/browser/terminalContextMenu.js';

registerTerminalContribution(TerminalVoiceContribution.ID, TerminalVoiceContribution);

registerAction2(
	class TerminalStartVoiceAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.terminal.startVoice',
				title: localize2({ bundle: 'ash', key: 'dictation.terminalStart' }, 'Terminal: Start dictation'),
				f1: true,
				icon: Lxicon.mic,
				precondition: TerminalDictationStateContext.isEqualTo('idle'),
				menu: {
					id: MenuId.TerminalTitle,
					group: 'navigation',
					order: 15,
					when: ContextKeyExpr.or(
						TerminalDictationStateContext.isEqualTo('idle'),
						TerminalDictationStateContext.isEqualTo('busy'),
					),
				},
			});
		}
		public override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
			const terminals = accessor.get(ITerminalService);
			const instance =
				context instanceof InstanceContext
					? terminals.instances.find(instance => instance.instanceId === context.instanceId)
					: terminals.activeInstance;
			await instance?.getContribution<TerminalVoiceContribution>(TerminalVoiceContribution.ID)?.start();
		}
	},
);
registerAction2(
	class TerminalStopVoiceAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.terminal.stopVoice',
				title: localize2({ bundle: 'ash', key: 'dictation.terminalStop' }, 'Terminal: Stop dictation'),
				f1: true,
				icon: Lxicon.stopCircle,
				precondition: TerminalDictationStateContext.isEqualTo('active'),
				menu: {
					id: MenuId.TerminalTitle,
					group: 'navigation',
					order: 15,
					when: TerminalDictationStateContext.isEqualTo('active'),
				},
			});
		}
		public override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
			const terminals = accessor.get(ITerminalService);
			const instance =
				context instanceof InstanceContext
					? terminals.instances.find(instance => instance.instanceId === context.instanceId)
					: terminals.activeInstance;
			await instance?.getContribution<TerminalVoiceContribution>(TerminalVoiceContribution.ID)?.stop();
		}
	},
);
