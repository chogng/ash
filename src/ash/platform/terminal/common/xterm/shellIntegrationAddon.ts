import { localize } from '../../../../nls.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { ITerminalLogService, ShellIntegrationStatus, type IShellIntegration, type ITerminalCommandScreen, type TerminalShellIntegrationEvent, type TerminalShellType } from '../terminal.js';
import { BufferMarkCapability } from '../capabilities/bufferMarkCapability.js';
import { ShellEnvDetectionCapability } from '../capabilities/shellEnvDetectionCapability.js';
import { CommandDetectionCapability } from '../capabilities/commandDetectionCapability.js';
import { PartialCommandDetectionCapability } from '../capabilities/partialCommandDetectionCapability.js';
import { TerminalCapability, type ITerminalCapabilityImplMap, type ISerializedCommandDetectionCapability } from '../capabilities/capabilities.js';
import { TerminalCapabilityStore } from '../capabilities/terminalCapabilityStore.js';

/** Adapts decoded, committed shell boundaries to screen models. Nonce parsing stays with Rust. */
export class ShellIntegrationAddon extends Disposable implements IShellIntegration {
	readonly capabilities: TerminalCapabilityStore;
	private terminal: ITerminalCommandScreen | undefined;
	private command: CommandDetectionCapability | undefined;
	private environment: ShellEnvDetectionCapability | undefined;
	private readonly seen = new Set<string>();
	private windowsPty = false;
	private shellType: TerminalShellType;
	private integrationStatus = ShellIntegrationStatus.Off;
	private readonly statusChanged = this._register(new Emitter<ShellIntegrationStatus>());
	private readonly sequencesChanged = this._register(new Emitter<ReadonlySet<string>>());
	readonly onDidChangeStatus = this.statusChanged.event;
	readonly onDidChangeSeenSequences = this.sequencesChanged.event;
	get status(): ShellIntegrationStatus {
		return this.integrationStatus;
	}
	get seenSequences(): ReadonlySet<string> {
		return new Set(this.seen);
	}

	constructor(
		capabilities: TerminalCapabilityStore,
		private readonly onDidExecuteText: Event<void> | undefined,
		@ITerminalLogService private readonly log: ITerminalLogService,
	) {
		super();
		this.capabilities = capabilities;
	}

	activate(
		terminal: ITerminalCommandScreen & {
			readonly options?: { readonly disableStdin?: boolean };
			readonly parser: ConstructorParameters<typeof PartialCommandDetectionCapability>[0]['parser'];
		},
	): void {
		this.terminal = terminal;
		this.add(TerminalCapability.BufferMarkDetection, new BufferMarkCapability(terminal));
		if (!terminal.options?.disableStdin) {
			this.add(TerminalCapability.PartialCommandDetection, new PartialCommandDetectionCapability(terminal, this.onDidExecuteText));
		}
	}

	/** Called only after xterm's write callback, including replay before the screen was created. */
	handleSequence(event: TerminalShellIntegrationEvent): void {
		if (!this.terminal || this.isDisposed) {
			return;
		}
		this.log.trace(localize('terminal.shellIntegration.sequence', 'Shell integration sequence: {0}', event.type));
		if (event.type === 'outputGap') {
			this.command?.invalidateCurrentCommand();
			this.environment?.setEnvironment(undefined, false);
			return;
		}
		if (event.type === 'processReady') {
			this.windowsPty = event.isWindowsPty;
			this.shellType = event.shellType;
			this.command?.reset(event.isWindowsPty);
			this.command?.promptInputModel.setShellType(this.shellType);
			this.environment?.setEnvironment(undefined, false);
			this.seen.clear();
			this.sequencesChanged.fire(this.seenSequences);
			if (this.integrationStatus !== ShellIntegrationStatus.Off) {
				this.integrationStatus = ShellIntegrationStatus.Off;
				this.statusChanged.fire(this.integrationStatus);
			}
			return;
		}
		if (!this.seen.has(event.type)) {
			this.seen.add(event.type);
			this.sequencesChanged.fire(this.seenSequences);
		}
		if (this.integrationStatus !== ShellIntegrationStatus.VSCode) {
			this.integrationStatus = ShellIntegrationStatus.VSCode;
			this.statusChanged.fire(this.integrationStatus);
		}
		if (event.type === 'promptType') {
			return;
		}
		if (event.type === 'environment' || event.type === 'environmentStart' || event.type === 'environmentEntry' || event.type === 'environmentDelete' || event.type === 'environmentEnd') {
			if (!this.environment) {
				this.environment = this.add(TerminalCapability.ShellEnvDetection, new ShellEnvDetectionCapability());
			}
			switch (event.type) {
				case 'environment':
					this.environment.setEnvironment(event.values, event.isTrusted);
					break;
				case 'environmentStart':
					this.environment.startEnvironmentSingleVar(event.clear, event.isTrusted);
					break;
				case 'environmentEntry':
					this.environment.setEnvironmentSingleVar(event.key, event.value, event.isTrusted);
					break;
				case 'environmentDelete':
					this.environment.deleteEnvironmentSingleVar(event.key, event.value, event.isTrusted);
					break;
				case 'environmentEnd':
					this.environment.endEnvironmentSingleVar(event.isTrusted);
					break;
			}
			return;
		}
		const command = this.ensureCommandDetection();
		switch (event.type) {
			case 'promptStart':
				command.handlePromptStart();
				break;
			case 'commandStart':
				command.handleCommandStart();
				break;
			case 'commandLine':
				command.setCommandLine(event.value, event.isTrusted);
				break;
			case 'commandExecuted':
				if (event.commandStorageDisabled) {
					command.setIsCommandStorageDisabled();
				}
				if (event.command !== undefined) {
					command.setCommandLine(event.command, event.isTrusted);
				}
				if (event.cwd !== undefined) {
					command.setCwd(event.cwd);
				}
				command.handleCommandExecuted({}, event);
				break;
			case 'commandFinished':
				command.handleCommandFinished(event.exitCode, { ignoreCommandLine: true }, event.durationMillis);
				break;
			case 'continuationStart':
				command.handleContinuationStart();
				break;
			case 'continuationEnd':
				command.handleContinuationEnd();
				break;
			case 'rightPromptStart':
				command.handleRightPromptStart();
				break;
			case 'rightPromptEnd':
				command.handleRightPromptEnd();
				break;
			case 'cwd':
				command.setCwd(event.value);
				break;
			case 'hasRichCommandDetection':
				command.setHasRichCommandDetection(event.value);
				break;
			case 'commandStorageDisabled':
				command.setIsCommandStorageDisabled();
				break;
		}
	}

	setNextCommandId(command: string, commandId: string): void {
		if (this.terminal) {
			this.ensureCommandDetection().setNextCommandId(command, commandId);
		}
	}
	deserialize(value: ISerializedCommandDetectionCapability): void {
		if (this.terminal) {
			this.ensureCommandDetection().deserialize(value);
		}
	}

	private ensureCommandDetection(): CommandDetectionCapability {
		if (!this.command) {
			this.command = this.add(TerminalCapability.CommandDetection, new CommandDetectionCapability(this.terminal!, this.log));
			this.command.setIsWindowsPty(this.windowsPty);
			this.command.promptInputModel.setShellType(this.shellType);
		}
		return this.command;
	}

	private add<T extends TerminalCapability, M extends ITerminalCapabilityImplMap[T] & IDisposable>(id: T, model: M): M {
		this._register(model);
		this.capabilities.add(id, model);
		this._register(
			toDisposable(() => {
				if (this.capabilities.get(id) === model) {
					this.capabilities.remove(id);
				}
			}),
		);
		return model;
	}
}
