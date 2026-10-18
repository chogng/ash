import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { CONTEXT_ACCESSIBILITY_MODE_ENABLED } from '../../../../../platform/accessibility/common/accessibility.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { TerminalContextKeys, TerminalHasActiveInstanceContext } from '../../../terminal/common/terminalContextKey.js';
import { ITerminalService, type ITerminalContribution } from '../../../terminal/browser/terminal.js';
import { registerTerminalContribution, type ITerminalContributionContext } from '../../../terminal/browser/terminalExtensions.js';
import { TerminalCommandHistory } from '../common/history.js';
import { TerminalHistoryCommandId } from '../common/terminal.history.js';

const HISTORY_CONTRIBUTION_ID = 'terminal.history';

class TerminalHistoryContribution extends Disposable implements ITerminalContribution {
	constructor(
		context: ITerminalContributionContext,
		@IConfigurationService configurationService: IConfigurationService,
		@IStorageService storageService: IStorageService,
	) {
		super();
		const { instance } = context;
		const history = new TerminalCommandHistory(configurationService, storageService);
		this._register(instance.onDidChangeCommandStatus(event => {
			if (event.status === 'running') return;
			history.record(instance.profile.profileId, event.status, event.command, event.isTrusted, instance.shellIntegration?.commandStorageDisabled === true);
		}));
	}
}

registerTerminalContribution(HISTORY_CONTRIBUTION_ID, TerminalHistoryContribution);

interface CommandHistoryPick extends IQuickPickItem {
	readonly command: string;
	readonly shellId: string;
}

registerAction2(class RunRecentCommandAction extends Action2 {
	constructor() {
		super({
			id: TerminalHistoryCommandId.RunRecentCommand,
			title: localize2('workbench.action.terminal.runRecentCommand', 'Terminal: Run Recent Command...'),
			f1: true,
			precondition: TerminalHasActiveInstanceContext.isEqualTo(true),
			keybinding: [
				{
					primary: KeyMod.CtrlCmd | KeyCode.KeyR,
					when: ContextKeyExpr.and(TerminalContextKeys.focus.isEqualTo(true), CONTEXT_ACCESSIBILITY_MODE_ENABLED.isEqualTo(true)),
					weight: KeybindingWeight.WorkbenchContrib,
				},
				{
					primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyR,
					mac: { primary: KeyMod.WinCtrl | KeyMod.Alt | KeyCode.KeyR },
					when: ContextKeyExpr.and(TerminalContextKeys.focus.isEqualTo(true), CONTEXT_ACCESSIBILITY_MODE_ENABLED.isEqualTo(false)),
					weight: KeybindingWeight.WorkbenchContrib,
				},
			],
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const terminals = accessor.get(ITerminalService);
		const instance = terminals.activeInstance;
		if (!instance || instance.isReadOnly || instance.state !== 'running') return;

		const shellId = instance.profile.profileId;
		const history = new TerminalCommandHistory(accessor.get(IConfigurationService), accessor.get(IStorageService));
		const items = history.getCommands(shellId).map(({ command }) => ({
			label: command.replace(/\s+/g, ' ').slice(0, 160),
			command,
			shellId,
		}));
		const pickerLifetime = new DisposableStore();
		try {
			const picker = pickerLifetime.add(accessor.get(IQuickInputService).createQuickPick<CommandHistoryPick>());
			picker.ariaLabel = localize('terminal.history.pickAriaLabel', 'Recent commands for this terminal profile');
			picker.placeholder = items.length > 0
				? localize('terminal.history.pickPlaceholder', 'Select a recent command to run in this terminal')
				: localize('terminal.history.empty', 'No saved commands for this terminal profile');
			picker.items = items;
			let selected: CommandHistoryPick | undefined;
			const command = await new Promise<CommandHistoryPick | undefined>(resolve => {
				pickerLifetime.add(picker.onDidAccept(() => {
					const item = picker.selectedItems[0];
					if (!item) return;

					selected = item;
					picker.hide();

				}));
				pickerLifetime.add(picker.onDidHide(() => resolve(selected)));
				pickerLifetime.add(toDisposable(() => resolve(undefined)));
				picker.show();
			});
			if (!command || terminals.activeInstance !== instance || !terminals.instances.includes(instance) || instance.isReadOnly || instance.state !== 'running'
				|| instance.profile.profileId !== command.shellId) return;
			await instance.sendText(command.command, true);
		} finally {
			pickerLifetime.dispose();
		}
	}
});

registerAction2(class ClearPreviousSessionHistoryAction extends Action2 {
	constructor() {
		super({
			id: TerminalHistoryCommandId.ClearPreviousSessionHistory,
			title: localize2('workbench.action.terminal.clearPreviousSessionHistory', 'Terminal: Clear Previous Session History'),
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): void {
		new TerminalCommandHistory(accessor.get(IConfigurationService), accessor.get(IStorageService)).clear();
	}
});
