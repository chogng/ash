import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import type { ILogService } from '../../../log/common/log.js';
import type { ITerminalCommandScreen, TerminalShellIntegrationEvent } from '../terminal.js';
import {
	CommandInvalidationReason,
	TerminalCapability,
	type ICommandDetectionCapability,
	type ICommandInvalidationRequest,
	type IHandleCommandOptions,
	type IMarkProperties,
	type ISerializedCommandDetectionCapability,
	type ITerminalCommand,
} from './capabilities.js';
import { PromptInputModel } from './commandDetection/promptInputModel.js';
import { PartialTerminalCommand, TerminalCommand, isFullTerminalCommand } from './commandDetection/terminalCommand.js';

type Marker = NonNullable<IMarkProperties['marker']>;

/** Owns only parsed screen coordinates and input state, never the PTY's retained command history. */
export class CommandDetectionCapability extends Disposable implements ICommandDetectionCapability {
	readonly type = TerminalCapability.CommandDetection;
	readonly promptInputModel: PromptInputModel;
	private readonly completed: TerminalCommand[] = [];
	private readonly commandLifetimes = new Map<TerminalCommand, DisposableStore>();
	private readonly started = this._register(new Emitter<ITerminalCommand>());
	private readonly executed = this._register(new Emitter<ITerminalCommand>());
	private readonly finished = this._register(new Emitter<ITerminalCommand>());
	private readonly invalidated = this._register(new Emitter<ITerminalCommand[]>());
	private readonly currentInvalidated = this._register(new Emitter<ICommandInvalidationRequest>());
	private readonly richChanged = this._register(new Emitter<boolean>());
	private readonly startChanged = this._register(new Emitter<void>());
	readonly onCommandStarted = this.started.event;
	readonly onCommandExecuted = this.executed.event;
	readonly onCommandFinished = this.finished.event;
	readonly onCommandInvalidated = this.invalidated.event;
	readonly onCurrentCommandInvalidated = this.currentInvalidated.event;
	readonly onSetRichCommandDetection = this.richChanged.event;
	private partial: PartialTerminalCommand | undefined;
	private active: TerminalCommand | undefined;
	private pendingLifetime: DisposableStore | undefined;
	private directory: string | undefined;
	private windows = false;
	private rich = false;
	private storageDisabled = false;
	private nextId: { command: string; id: string } | undefined;
	get commands(): readonly ITerminalCommand[] {
		return this.completed;
	}
	get currentCommand(): PartialTerminalCommand | undefined {
		return this.partial;
	}
	get executingCommandObject(): ITerminalCommand | undefined {
		return this.partial?.commandExecutedMarker ? this.active : undefined;
	}
	get executingCommand(): string | undefined {
		return this.executingCommandObject?.command;
	}
	get executingCommandConfidence(): ITerminalCommand['commandLineConfidence'] | undefined {
		return this.executingCommandObject?.commandLineConfidence;
	}
	get cwd(): string | undefined {
		return this.directory;
	}
	get hasRichCommandDetection(): boolean {
		return this.rich;
	}

	constructor(
		private readonly terminal: ITerminalCommandScreen,
		private readonly log: ILogService,
	) {
		super();
		this.promptInputModel = this._register(new PromptInputModel(terminal, this.onCommandStarted, this.startChanged.event, this.onCommandExecuted, this.onCommandFinished, log));
		this._register(
			this.promptInputModel.onDidInterrupt(() => {
				if (this.partial) {
					this.partial.isInvalid = true;
				}
			}),
		);
	}

	invalidateCurrentCommand(): void {
		if (this.partial) {
			this.invalidatePending();
		}
		this.promptInputModel.reset();
	}

	reset(isWindowsPty: boolean): void {
		if (this.partial) {
			this.invalidatePending();
		}
		this.windows = isWindowsPty;
		this.directory = undefined;
		this.storageDisabled = false;
		this.nextId = undefined;
		this.setHasRichCommandDetection(false);
		this.promptInputModel.reset();
	}

	setCwd(value: string): void {
		this.directory = value;
	}
	setIsWindowsPty(value: boolean): void {
		this.windows = value;
	}
	setContinuationPrompt(value: string): void {
		this.promptInputModel.setContinuationPrompt(value);
	}
	setPromptTerminator(value: string, lastPromptLine: string): void {
		this.promptInputModel.setLastPromptLine(lastPromptLine);
		if (this.partial && !this.partial.commandExecutedMarker && lastPromptLine.endsWith(value)) {
			this.startChanged.fire();
		}
	}

	setHasRichCommandDetection(value: boolean): void {
		if (this.rich === value) {
			return;
		}
		this.rich = value;
		this.richChanged.fire(value);
	}

	setIsCommandStorageDisabled(): void {
		this.storageDisabled = true;
		for (const command of [...this.completed, ...(this.active ? [this.active] : [])]) {
			command.command = '';
			command.isTrusted = false;
			command.commandLineConfidence = 'low';
			command.commandStartLineContent = undefined;
		}
		if (this.partial) {
			this.partial.command = undefined;
			this.partial.isTrusted = false;
			this.partial.commandStartLineContent = undefined;
		}
	}

	setCommandLine(commandLine: string, isTrusted: boolean): void {
		if (!this.partial) {
			this.partial = new PartialTerminalCommand(this.terminal);
			this.pendingLifetime = new DisposableStore();
		}
		if (this.storageDisabled) {
			return;
		}
		this.partial.command = commandLine;
		this.partial.isTrusted = isTrusted;
		if (this.active) {
			this.active.command = commandLine;
			this.active.isTrusted = isTrusted;
			this.active.commandLineConfidence = isTrusted ? 'high' : 'medium';
		}
		this.promptInputModel.setConfidentCommandLine(commandLine);
	}

	setNextCommandId(command: string, commandId: string): void {
		this.nextId = { command, id: commandId };
		if (this.active && this.active.command === command) {
			this.active.id = commandId;
		}
	}

	handlePromptStart(options: IHandleCommandOptions = {}): void {
		if (this.partial) {
			this.invalidatePending();
		}
		this.partial = new PartialTerminalCommand(this.terminal);
		this.pendingLifetime = new DisposableStore();
		this.partial.promptStartMarker = this.marker(options);
	}

	handleCommandStart(options: IHandleCommandOptions = {}): void {
		if (!this.partial) {
			this.handlePromptStart();
		}
		const partial = this.partial!;
		partial.commandStartMarker = this.marker(options);
		if (!partial.commandStartMarker) {
			return;
		}
		const start = partial.commandStartMarker;
		const trimmed = this.onMarkerDispose(start, () => {
			if (this.partial !== partial) {
				return;
			}
			partial.isInvalid = true;
			this.currentInvalidated.fire({ reason: CommandInvalidationReason.NoProblemsReported });
			this.promptInputModel.reset();
		});
		this.pendingLifetime!.add(trimmed);
		partial.commandStartX = this.terminal.buffer.normal.cursorX;
		partial.commandStartLineContent = this.storageDisabled ? undefined : this.terminal.buffer.normal.getLine(partial.commandStartMarker.line)?.translateToString(true);
		this.active = partial.promoteToFullCommand(this.directory, undefined, true, options.markProperties);
		if (this.active) {
			this.started.fire(this.active);
		}
	}

	handleCommandExecuted(options: IHandleCommandOptions = {}, metadata?: Extract<TerminalShellIntegrationEvent, { type: 'commandExecuted' }>): void {
		// After an output gap the execution boundary may be our first retained
		// position. Anchor at that observed position rather than reconstructing
		// a prompt or echoed command that is no longer in this screen.
		if (!this.active) {
			this.handleCommandStart(options);
		}
		if (!this.partial || !this.active || this.partial.commandExecutedMarker) {
			return;
		}
		const partial = this.partial;
		partial.commandExecutedMarker = this.marker(options);
		partial.commandExecutedX = this.terminal.buffer.normal.cursorX;
		partial.markExecutedTime();
		this.active.executedMarker = partial.commandExecutedMarker;
		this.active.executedX = partial.commandExecutedX;
		if (partial.command === undefined && !this.storageDisabled) {
			this.active.command = this.active.extractCommandLine();
			this.active.commandLineConfidence = 'low';
		}
		this.active.timestamp = metadata?.timestampMillis ?? Date.now();
		if (metadata) {
			this.active.id = metadata.commandId;
			this.active.cwd = metadata.cwd ?? this.directory;
		}
		if (this.nextId && this.nextId.command === this.active.command) {
			this.active.id = this.nextId.id;
		}
		this.nextId = undefined;
		this.executed.fire(this.active);
	}

	handleCommandFinished(exitCode?: number, options: IHandleCommandOptions = {}, durationMillis?: number): void {
		const command = this.active;
		const partial = this.partial;
		if (!command || !partial) {
			return;
		}
		partial.commandFinishedMarker = this.marker(options);
		partial.markFinishedTime();
		command.endMarker = partial.commandFinishedMarker;
		command.exitCode = exitCode;
		command.duration = durationMillis ?? Math.max(0, Date.now() - command.timestamp);
		const lifetime = this.pendingLifetime!;
		this.partial = undefined;
		this.active = undefined;
		this.pendingLifetime = undefined;
		if (partial.isInvalid || (!command.command && !options.ignoreCommandLine && !this.storageDisabled)) {
			lifetime.dispose();
			return;
		}
		this.completed.push(command);
		this.commandLifetimes.set(command, lifetime);
		if (command.marker) {
			lifetime.add(this.onMarkerDispose(command.marker, () => this.remove([command])));
		}
		while (this.completed.length > 512) {
			this.remove([this.completed[0]!]);
		}
		this.finished.fire(command);
	}

	handleContinuationStart(): void {
		if (!this.partial) {
			return;
		}
		this.partial.currentContinuationMarker = this.marker();
	}

	handleContinuationEnd(): void {
		const current = this.partial?.currentContinuationMarker;
		if (!current || current.isDisposed) {
			return;
		}
		const end = this.terminal.buffer.normal.cursorX;
		(this.partial!.continuations ??= []).push({ marker: current, end });
		const prompt = this.terminal.buffer.normal.getLine(current.line)?.translateToString(false, 0, end);
		if (prompt !== undefined) {
			this.setContinuationPrompt(prompt);
		}
		this.partial!.currentContinuationMarker = undefined;
	}

	handleRightPromptStart(): void {
		if (this.partial) {
			this.partial.commandRightPromptStartX = this.terminal.buffer.normal.cursorX;
		}
	}
	handleRightPromptEnd(): void {
		if (!this.partial) {
			return;
		}
		this.partial.commandRightPromptEndX = this.terminal.buffer.normal.cursorX;
		if (this.partial.commandRightPromptStartX !== undefined) {
			this.promptInputModel.setRightPromptRange(this.partial.commandRightPromptStartX, this.partial.commandRightPromptEndX);
		}
		this.startChanged.fire();
	}

	getCommandForLine(line: number): ITerminalCommand | PartialTerminalCommand | undefined {
		if (this.partial?.commandStartMarker && line >= this.partial.commandStartMarker.line) {
			return this.partial;
		}
		for (let index = this.completed.length - 1; index >= 0; index--) {
			const command = this.completed[index]!;
			if (!command.marker?.isDisposed && command.marker !== undefined && command.marker.line <= line && (command.endMarker?.line ?? Infinity) >= line) {
				return command;
			}
		}
		return undefined;
	}

	getCwdForLine(line: number): string | undefined {
		const command = this.getCommandForLine(line);
		return command && isFullTerminalCommand(command) ? command.cwd : command ? (this.active?.cwd ?? this.directory) : undefined;
	}

	clearCommands(): void {
		this.remove([...this.completed]);
	}

	serialize(): ISerializedCommandDetectionCapability {
		const commands = this.completed.map(command => command.serialize(this.storageDisabled));
		if (this.active && !this.partial?.isInvalid) {
			commands.push(this.active.serialize(this.storageDisabled));
		}
		return {
			isWindowsPty: this.windows,
			hasRichCommandDetection: this.rich,
			commands,
			promptInputModel: this.storageDisabled ? undefined : this.promptInputModel.serialize(),
		};
	}

	deserialize(value: ISerializedCommandDetectionCapability): void {
		this.clearCommands();
		this.invalidateCurrentCommand();
		this.windows = value.isWindowsPty;
		this.setHasRichCommandDetection(value.hasRichCommandDetection);
		for (const item of value.commands) {
			const command = TerminalCommand.deserialize(this.terminal, item, this.storageDisabled);
			if (!command) {
				continue;
			}
			const lifetime = new DisposableStore();
			for (const marker of new Set([command.marker, command.promptStartMarker, command.executedMarker, command.endMarker]))
				if (marker) {
					lifetime.add(toDisposable(() => marker.dispose()));
				}
			if (item.endLine === undefined) {
				if (this.partial) {
					this.invalidatePending();
				}
				const partial = new PartialTerminalCommand(this.terminal, command.id);
				partial.commandStartMarker = command.marker;
				partial.promptStartMarker = command.promptStartMarker;
				partial.commandExecutedMarker = command.executedMarker;
				partial.commandStartX = command.startX;
				partial.commandExecutedX = command.executedX;
				partial.command = this.storageDisabled || (!command.command && command.commandLineConfidence === 'low') ? undefined : command.command;
				partial.isTrusted = command.isTrusted;
				this.partial = partial;
				this.active = command;
				this.directory = command.cwd;
				this.pendingLifetime = lifetime;
				if (command.marker) {
					lifetime.add(
						this.onMarkerDispose(command.marker, () => {
							if (this.partial === partial) {
								this.invalidateCurrentCommand();
							}
						}),
					);
				}
				this.started.fire(command);
				if (command.executedMarker) {
					this.executed.fire(command);
				}
				continue;
			}
			if (command.marker) {
				lifetime.add(this.onMarkerDispose(command.marker, () => this.remove([command])));
			}
			this.completed.push(command);
			this.commandLifetimes.set(command, lifetime);
			while (this.completed.length > 512) {
				this.remove([this.completed[0]!]);
			}
			this.finished.fire(command);
		}
		if (value.promptInputModel) {
			this.promptInputModel.deserialize(value.promptInputModel);
		}
	}

	private marker(options: IHandleCommandOptions = {}): Marker | undefined {
		const marker = options.marker ?? this.terminal.registerMarker(0);
		if (!marker || marker.isDisposed) {
			return undefined;
		}
		if (!options.marker) {
			this.pendingLifetime?.add(toDisposable(() => marker.dispose()));
		}
		return marker;
	}

	private onMarkerDispose(marker: Marker, listener: () => void) {
		return Event.once<void>(callback => {
			const subscription = marker.onDispose(callback);
			return toDisposable(() => subscription.dispose());
		})(listener);
	}

	private invalidatePending(): void {
		this.currentInvalidated.fire({
			reason: this.windows ? CommandInvalidationReason.Windows : CommandInvalidationReason.NoProblemsReported,
		});
		this.log.trace('Abandoned screen command', this.active?.id);
		this.partial = undefined;
		this.active = undefined;
		this.pendingLifetime?.dispose();
		this.pendingLifetime = undefined;
	}

	private remove(commands: TerminalCommand[]): void {
		const removed: TerminalCommand[] = [];
		for (const command of commands) {
			const index = this.completed.indexOf(command);
			if (index < 0) {
				continue;
			}
			this.completed.splice(index, 1);
			removed.push(command);
			const lifetime = this.commandLifetimes.get(command);
			this.commandLifetimes.delete(command);
			lifetime?.dispose();
		}
		if (removed.length) {
			this.invalidated.fire(removed);
		}
	}

	protected override disposeCore(): void {
		this.pendingLifetime?.dispose();
		this.pendingLifetime = undefined;
		for (const lifetime of this.commandLifetimes.values()) {
			lifetime.dispose();
		}
		this.commandLifetimes.clear();
		this.completed.length = 0;
		super.disposeCore();
	}
}
