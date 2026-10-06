import { getErrorMessage } from '../../../../base/common/errors.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';

type RunnableCommand = string | { readonly command: string; readonly args?: unknown; };

interface CommandArgs {
	readonly commands: readonly RunnableCommand[];
}

registerAction2(class RunCommands extends Action2 {
	constructor() {
		super({
			id: 'runCommands',
			title: localize2('runCommands', 'Run Commands'),
			f1: false,
			metadata: {
				description: localize('runCommands.description', 'Run several commands'),
				args: [{
					name: 'args',
					schema: {
						type: 'object',
						required: ['commands'],
						properties: {
							commands: {
								type: 'array',
								description: localize('runCommands.commands', 'Commands to run'),
								items: {
									anyOf: [
										{ type: 'string' },
										{ type: 'object', required: ['command'], properties: { command: { type: 'string' }, args: {} } },
									],
								},
							},
						},
					},
				}],
			},
		});
	}

	public override async run(accessor: ServicesAccessor, args: unknown): Promise<void> {
		const notifications = accessor.get(INotificationService);
		if (!isCommandArgs(args)) {
			notifications.error(localize('runCommands.invalidArgs', "'runCommands' has received an argument with incorrect type. Please, review the argument passed to the command."));
			return;
		}
		if (args.commands.length === 0) {
			notifications.warning(localize('runCommands.noCommandsToRun', "'runCommands' has not received commands to run. Did you forget to pass commands in the 'runCommands' argument?"));
			return;
		}

		const commands = accessor.get(ICommandService);
		const log = accessor.get(ILogService);
		for (const entry of args.commands) {
			const id = typeof entry === 'string' ? entry : entry.command;
			const values = typeof entry === 'string' ? undefined : entry.args;
			// A keybinding supplies one argument object; arrays inside it represent positional command arguments.
			let parameters: readonly unknown[] = [];
			if (values !== undefined) {
				parameters = Array.isArray(values) ? values : [values];
			}
			try {
				log.debug('runCommands', `Executing ${id}`);
				await commands.executeCommand(id, ...parameters);
			} catch (error) {
				log.debug('runCommands', `Command ${id} failed`, error);
				notifications.error(getErrorMessage(error));
				return;
			}
		}
	}
});

function isCommandArgs(value: unknown): value is CommandArgs {
	if (typeof value !== 'object' || value === null || !('commands' in value) || !Array.isArray(value.commands)) {
		return false;
	}
	return value.commands.every(entry => typeof entry === 'string' || (
		typeof entry === 'object' && entry !== null && typeof entry.command === 'string'
	));
}
