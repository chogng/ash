import { type IDisposable, toDisposable } from "../../../base/common/lifecycle.js";
import type { Event } from "../../../base/common/event.js";
import type { ServicesAccessor } from "../../instantiation/common/instantiation.js";
import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";
import type { JsonSchema } from '../../../base/common/jsonSchema.js';
import { validateConstraints, type TypeConstraint } from '../../../base/common/types.js';
import type { ILocalizedString } from '../../action/common/action.js';

export type CommandId = string;
export type CommandHandler = (
	accessor: ServicesAccessor,
	...args: readonly unknown[]
) => unknown;

export interface CommandDefinition {
	readonly id: CommandId;
	readonly handler: CommandHandler;
	readonly metadata?: ICommandMetadata;
}

export interface ICommandMetadata {
	readonly description: ILocalizedString | string;
	readonly args?: ReadonlyArray<{
		readonly name: string;
		readonly isOptional?: boolean;
		readonly description?: string;
		readonly constraint?: TypeConstraint;
		readonly schema?: JsonSchema;
	}>;
	readonly returns?: string;
}

/** One caller-owned command set that can be atomically replaced. */
export interface CommandRegistration extends IDisposable {
	replace(commands: readonly CommandDefinition[]): void;
}

/** A command invocation observed immediately around its handler call. */
export interface ICommandEvent {
	readonly commandId: CommandId;
	readonly args: readonly unknown[];
}

/** Stores realm-wide command definitions independently of their UI bindings. */
export class CommandRegistry {
	private readonly commands = new Map<CommandId, { readonly owner: object; readonly handler: CommandHandler }>();

	register(id: CommandId, command: CommandHandler): IDisposable {
		return this.registerMany([{ id, handler: command }]);
	}

	registerMany(commands: readonly CommandDefinition[]): CommandRegistration {
		const owner = Object.freeze({});
		this.replace(owner, commands);
		let disposed = false;
		const registration = toDisposable(() => {
			if (disposed) return;
			disposed = true;
			this.deleteOwner(owner);
		}) as CommandRegistration;
		registration.replace = replacement => {
			if (disposed) throw new ReferenceError("Command registration is already disposed");
			this.replace(owner, replacement);
		};
		return registration;
	}

	getCommand(id: CommandId): CommandHandler | undefined {
		return this.commands.get(id)?.handler;
	}

	hasCommand(id: CommandId): boolean {
		return this.commands.has(id);
	}

	getCommandIds(): readonly CommandId[] {
		return Object.freeze([...this.commands.keys()].sort());
	}

	private replace(owner: object, commands: readonly CommandDefinition[]): void {
		if (!Array.isArray(commands)) throw new TypeError("Commands must be an array");
		const normalized = commands.map(normalizeCommandDefinition);
		const ids = new Set<CommandId>();
		for (const command of normalized) {
			const existing = this.commands.get(command.id);
			if (ids.has(command.id) || existing && existing.owner !== owner) throw new Error(`Command is already registered: ${command.id}`);
			ids.add(command.id);
		}
		this.deleteOwner(owner);
		for (const command of normalized) this.commands.set(command.id, { owner, handler: command.handler });
	}

	private deleteOwner(owner: object): void {
		for (const [id, command] of this.commands) if (command.owner === owner) this.commands.delete(id);
	}
}

function normalizeCommandDefinition(command: CommandDefinition): CommandDefinition {
	if (!command || typeof command !== "object") throw new TypeError("Command definition must be an object");
	if (typeof command.id !== "string" || command.id.trim().length === 0 || command.id.length > 256 || command.id.includes("\0")) throw new TypeError("Command ID must contain 1 to 256 characters without NUL");
	if (typeof command.handler !== "function") throw new TypeError(`Command '${command.id}' must provide a handler`);
	const constraints = command.metadata?.args?.map(argument => argument.constraint);
	const execute = command.handler;
	const handler = constraints
		? (accessor: ServicesAccessor, ...args: unknown[]): unknown => {
			validateConstraints(args, constraints);
			return execute(accessor, ...args);
		}
		: execute;
	return Object.freeze({ id: command.id.trim(), handler, metadata: command.metadata });
}

/** Realm-wide command definitions populated by static contributions. */
export const CommandsRegistry = new CommandRegistry();

export interface ICommandService {
	readonly onWillExecuteCommand: Event<ICommandEvent>;
	readonly onDidExecuteCommand: Event<ICommandEvent>;
	executeCommand<T = unknown>(
		id: CommandId,
		...args: readonly unknown[]
	): Promise<T>;
}

export const ICommandService =
	createServiceIdentifier<ICommandService>("commandService");
