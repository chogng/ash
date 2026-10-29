import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerTerminalContribution } from '../../../terminal/browser/terminalExtensions.js';
import { TerminalStickyScrollSettingId } from '../common/terminalStickyScrollConfiguration.js';
import { TerminalStickyScrollContribution } from './terminalStickyScrollContribution.js';

registerTerminalContribution(TerminalStickyScrollContribution.ID, TerminalStickyScrollContribution);

registerAction2(
	class TerminalToggleStickyScrollAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.terminal.toggleStickyScroll',
				title: localize2('terminal.stickyScroll.toggle', 'Terminal: Toggle Sticky Scroll'),
				f1: true,
			});
		}

		public override run(accessor: ServicesAccessor): Promise<void> {
			const configuration = accessor.get(IConfigurationService);
			return configuration.updateValue(TerminalStickyScrollSettingId.Enabled, !configuration.getValue<boolean>(TerminalStickyScrollSettingId.Enabled));
		}
	},
);
