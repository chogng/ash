import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
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
import {
	registerTerminalContribution,
	type ITerminalContributionContext,
} from '../../../terminal/browser/terminalExtensions.js';
import { TerminalCommandHistory, TerminalDirectoryHistory } from '../common/history.js';
import { TerminalHistoryCommandId } from '../common/terminal.history.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { GeneralShellType, PosixShellType } from '../../../../../platform/terminal/common/terminal.js';
import { escapeNonWindowsPath } from '../../../../../platform/terminal/common/terminalEnvironment.js';
import type { ITerminalInstance } from '../../../terminal/browser/terminal.js';

const HISTORY_CONTRIBUTION_ID = 'terminal.history';

class TerminalHistoryContribution extends Disposable implements ITerminalContribution {
	constructor(
		context: ITerminalContributionContext,
		@IConfigurationService configurationService: IConfigurationService,
		@IStorageService storageService: IStorageService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
	) {
		super();
		const { instance } = context;
		const history = new TerminalCommandHistory(configurationService, storageService);
		const directories = new TerminalDirectoryHistory(configurationService, storageService);
		const scope = directoryScope(workspace, instance);
		const cwdListener = this._register(new MutableDisposable());
		const recordDirectory = (): void => {
			const cwd = instance.capabilities?.get(TerminalCapability.CwdDetection);
			if (scope && cwd)
				directories.record(
					scope,
					cwd.getCwd(),
					cwd.isTrusted,
					instance.shellIntegration?.commandStorageDisabled === true,
				);
		};
		const bindDirectory = (): void => {
			cwdListener.value = instance.capabilities
				?.get(TerminalCapability.CwdDetection)
				?.onDidChangeCwd(recordDirectory);
			recordDirectory();
		};
		bindDirectory();
		if (instance.capabilities) {
			this._register(
				instance.capabilities.createOnDidAddCapabilityOfTypeEvent(TerminalCapability.CwdDetection)(
					bindDirectory,
				),
			);
			this._register(
				instance.capabilities.createOnDidRemoveCapabilityOfTypeEvent(TerminalCapability.CwdDetection)(() =>
					cwdListener.clear(),
				),
			);
		}
		this._register(
			instance.onDidChangeCommandStatus(event => {
				if (event.status === 'running') return;
				recordDirectory();
				history.record(
					instance.profile.profileId,
					event.status,
					event.command,
					event.isTrusted,
					instance.shellIntegration?.commandStorageDisabled === true,
				);
			}),
		);
	}
}

registerTerminalContribution(HISTORY_CONTRIBUTION_ID, TerminalHistoryContribution);

function directoryScope(workspace: IWorkspaceContextService, instance: ITerminalInstance): string | undefined {
	const current = workspace.getWorkspace();
	const root = current.folders.find(folder => folder.id === instance.dirId);
	return root
		? JSON.stringify([current.id, current.remoteAuthority ?? '', root.uri.scheme, root.uri.authority])
		: undefined;
}

registerAction2(
	class GoToRecentDirectoryAction extends Action2 {
		constructor() {
			super({
				id: TerminalHistoryCommandId.GoToRecentDirectory,
				title: localize2('terminal.history.goToDirectory', 'Terminal: Go to Recent Directory...'),
				f1: true,
				precondition: TerminalHasActiveInstanceContext.isEqualTo(true),
			});
		}
		override async run(accessor: ServicesAccessor): Promise<void> {
			const terminals = accessor.get(ITerminalService);
			const instance = terminals.activeInstance;
			if (!instance || instance.isReadOnly || instance.state !== 'running') return;
			const processId = instance.processId;
			const workspace = accessor.get(IWorkspaceContextService);
			const scope = directoryScope(workspace, instance);
			const shell = instance.shellType;
			if (
				!scope ||
				(shell !== GeneralShellType.PowerShell && shell !== PosixShellType.Bash && shell !== PosixShellType.Zsh)
			)
				throw new Error(
					localize(
						'terminal.path.unsupportedShell',
						'This terminal does not have a supported, confirmed shell for sending paths.',
					),
				);
			const history = new TerminalDirectoryHistory(
				accessor.get(IConfigurationService),
				accessor.get(IStorageService),
			);
			using lifetime = new DisposableStore();
			const picker = lifetime.add(accessor.get(IQuickInputService).createQuickPick<IQuickPickItem>());
			picker.ariaLabel = localize(
				'terminal.history.directoryAria',
				'Recent directories on this terminal execution host',
			);
			const refresh = (): void => {
				const items = history
					.getDirectories(scope)
					.filter(path => shell === GeneralShellType.PowerShell || path.startsWith('/'))
					.map(path => ({ label: path }));
				picker.placeholder = items.length
					? localize('terminal.history.directoryPlaceholder', 'Select a directory to open in this terminal')
					: localize(
							'terminal.history.directoryEmpty',
							'No verified directories for this terminal execution host',
						);
				picker.items = items;
			};
			refresh();
			lifetime.add(history.onDidChange(refresh));
			let retired = false;
			const retire = (): void => {
				retired = true;
				picker.hide();
			};
			lifetime.add(instance.onDidChangeState(retire));
			lifetime.add(instance.onDidExit(retire));
			lifetime.add(terminals.onDidChangeActiveInstance(retire));
			lifetime.add(
				terminals.onDidDisposeInstance(disposed => {
					if (disposed === instance) retire();
				}),
			);
			lifetime.add(workspace.onDidChangeWorkspace(retire));
			const canSend = (): boolean =>
				!retired &&
				terminals.activeInstance === instance &&
				terminals.instances.includes(instance) &&
				instance.processId === processId &&
				instance.state === 'running' &&
				!instance.isReadOnly &&
				instance.shellType === shell &&
				directoryScope(workspace, instance) === scope;
			let selected: IQuickPickItem | undefined;
			const directory = await new Promise<IQuickPickItem | undefined>(resolve => {
				lifetime.add(
					picker.onDidAccept(() => {
						selected = picker.selectedItems[0];
						picker.hide();
					}),
				);
				lifetime.add(picker.onDidHide(() => resolve(selected)));
				lifetime.add(toDisposable(() => resolve(undefined)));
				picker.show();
			});
			if (!directory || !canSend()) return;
			const command = shell === GeneralShellType.PowerShell ? 'Set-Location -LiteralPath ' : 'cd -- ';
			await instance.sendText(command + escapeNonWindowsPath(directory.label, shell), true);
			if (canSend()) instance.xterm?.focus();
		}
	},
);

interface CommandHistoryPick extends IQuickPickItem {
	readonly command: string;
	readonly shellId: string;
}

registerAction2(
	class RunRecentCommandAction extends Action2 {
		constructor() {
			super({
				id: TerminalHistoryCommandId.RunRecentCommand,
				title: localize2('workbench.action.terminal.runRecentCommand', 'Terminal: Run Recent Command...'),
				f1: true,
				precondition: TerminalHasActiveInstanceContext.isEqualTo(true),
				keybinding: [
					{
						primary: KeyMod.CtrlCmd | KeyCode.KeyR,
						when: ContextKeyExpr.and(
							TerminalContextKeys.focus.isEqualTo(true),
							CONTEXT_ACCESSIBILITY_MODE_ENABLED.isEqualTo(true),
						),
						weight: KeybindingWeight.WorkbenchContrib,
					},
					{
						primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyR,
						mac: { primary: KeyMod.WinCtrl | KeyMod.Alt | KeyCode.KeyR },
						when: ContextKeyExpr.and(
							TerminalContextKeys.focus.isEqualTo(true),
							CONTEXT_ACCESSIBILITY_MODE_ENABLED.isEqualTo(false),
						),
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
			const processId = instance.processId;
			const workspace = accessor.get(IWorkspaceContextService);
			const history = new TerminalCommandHistory(
				accessor.get(IConfigurationService),
				accessor.get(IStorageService),
			);
			const items = history
				.getCommands(shellId)
				.map(({ command }) => ({ label: command.replace(/\s+/g, ' ').slice(0, 160), command, shellId }));
			const pickerLifetime = new DisposableStore();
			try {
				const picker = pickerLifetime.add(
					accessor.get(IQuickInputService).createQuickPick<CommandHistoryPick>(),
				);
				picker.ariaLabel = localize(
					'terminal.history.pickAriaLabel',
					'Recent commands for this terminal profile',
				);
				picker.placeholder =
					items.length > 0
						? localize(
								'terminal.history.pickPlaceholder',
								'Select a recent command to run in this terminal',
							)
						: localize('terminal.history.empty', 'No saved commands for this terminal profile');
				picker.items = items;
				// Returning to the same terminal or shell state cannot revive an old choice.
				let retired = false;
				const retire = (): void => {
					retired = true;
					picker.hide();
				};
				pickerLifetime.add(instance.onDidChangeState(retire));
				pickerLifetime.add(instance.onDidExit(retire));
				pickerLifetime.add(terminals.onDidChangeActiveInstance(retire));
				pickerLifetime.add(
					terminals.onDidDisposeInstance(disposed => {
						if (disposed === instance) retire();
					}),
				);
				pickerLifetime.add(workspace.onDidChangeWorkspace(retire));
				let selected: CommandHistoryPick | undefined;
				const command = await new Promise<CommandHistoryPick | undefined>(resolve => {
					pickerLifetime.add(
						picker.onDidAccept(() => {
							const item = picker.selectedItems[0];
							if (!item) return;

							selected = item;
							picker.hide();
						}),
					);
					pickerLifetime.add(picker.onDidHide(() => resolve(selected)));
					pickerLifetime.add(toDisposable(() => resolve(undefined)));
					picker.show();
				});
				if (
					!command ||
					retired ||
					terminals.activeInstance !== instance ||
					!terminals.instances.includes(instance) ||
					instance.processId !== processId ||
					instance.isReadOnly ||
					instance.state !== 'running' ||
					instance.profile.profileId !== command.shellId
				)
					return;
				await instance.sendText(command.command, true);
			} finally {
				pickerLifetime.dispose();
			}
		}
	},
);

registerAction2(
	class ClearPreviousSessionHistoryAction extends Action2 {
		constructor() {
			super({
				id: TerminalHistoryCommandId.ClearPreviousSessionHistory,
				title: localize2(
					'workbench.action.terminal.clearPreviousSessionHistory',
					'Terminal: Clear Previous Session History',
				),
				f1: true,
			});
		}

		override run(accessor: ServicesAccessor): void {
			new TerminalCommandHistory(accessor.get(IConfigurationService), accessor.get(IStorageService)).clear();
			new TerminalDirectoryHistory(accessor.get(IConfigurationService), accessor.get(IStorageService)).clear();
		}
	},
);
