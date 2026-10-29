import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { TerminalHasActiveInstanceContext } from '../../../terminal/common/terminalContextKey.js';

export const enum TerminalSendSignalCommandId {
	SendSignal = 'workbench.action.terminal.sendSignal',
}

registerAction2(
	class SendSignalAction extends Action2 {
		constructor() {
			super({
				id: TerminalSendSignalCommandId.SendSignal,
				title: localize2('terminal.sendSignal.title', 'Terminal: Send Signal'),
				f1: true,
				precondition: TerminalHasActiveInstanceContext.isEqualTo(true),
				metadata: {
					description: localize('terminal.sendSignal.description', 'Send a process signal to the active terminal’s foreground command.'),
					args: [
						{
							name: 'args',
							isOptional: true,
							schema: {
								type: 'object',
								required: ['signal'],
								properties: { signal: { type: 'string' } },
							},
						},
					],
				},
			});
		}

		override async run(accessor: ServicesAccessor, args?: unknown): Promise<void> {
			let signal: string | undefined;
			if (args !== undefined) {
				if (!args || typeof args !== 'object' || Array.isArray(args) || !('signal' in args) || typeof args.signal !== 'string') {
					throw new TypeError(localize('terminal.sendSignal.invalidArgs', 'Send Signal requires an object with a string signal property.'));
				}
				signal = args.signal;
			}
			const terminals = accessor.get(ITerminalService);
			const instance = terminals.activeInstance;
			if (!instance || instance.isReadOnly || instance.state !== 'running') return;
			if (signal === undefined) {
				using lifetime = new DisposableStore();
				const picker = lifetime.add(accessor.get(IQuickInputService).createQuickPick());
				picker.placeholder = localize('terminal.sendSignal.placeholder', 'Select a signal to send to the foreground command');
				picker.ariaLabel = picker.placeholder;
				picker.items = [
					{ label: 'SIGINT', description: localize('terminal.sendSignal.interrupt', 'Interrupt command') },
					{
						label: 'SIGTERM',
						description: localize('terminal.sendSignal.terminate', 'Terminate command gracefully'),
					},
					{ label: 'SIGKILL', description: localize('terminal.sendSignal.kill', 'Force kill command') },
					{ label: 'SIGHUP', description: localize('terminal.sendSignal.hangup', 'Hang up command') },
				];
				let retired = false;
				const retire = (): void => {
					retired = true;
					picker.hide();
				};
				lifetime.add(accessor.get(IWorkspaceContextService).onDidChangeWorkspace(retire));
				lifetime.add(instance.onDidChangeState(retire));
				lifetime.add(instance.onDidExit(retire));
				lifetime.add(terminals.onDidChangeActiveInstance(retire));
				lifetime.add(
					terminals.onDidDisposeInstance(closed => {
						if (closed === instance) retire();
					}),
				);
				signal = await new Promise<string | undefined>(resolve => {
					let selected: string | undefined;
					lifetime.add(
						picker.onDidAccept(() => {
							selected = picker.selectedItems[0]?.label;
							picker.hide();
						}),
					);
					lifetime.add(picker.onDidHide(() => resolve(selected)));
					picker.show();
				});
				if (!retired && terminals.activeInstance === instance) instance.xterm?.focus();
				if (!signal || retired || terminals.activeInstance !== instance || !terminals.instances.includes(instance) || instance.state !== 'running' || instance.isReadOnly) return;
			}
			await instance.sendSignal(signal);
		}
	},
);
