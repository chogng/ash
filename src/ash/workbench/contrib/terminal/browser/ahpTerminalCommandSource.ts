import { CwdDetectionCapability } from '../../../../platform/terminal/common/capabilities/cwdDetectionCapability.js';
import { PromptTypeDetectionCapability } from '../../../../platform/terminal/common/capabilities/promptTypeDetectionCapability.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { ITerminalProcessReadResult, ITerminalProcessCommandStatusEvent } from '../../../../platform/terminal/common/terminal.js';
import type { ITerminalCommandStatusEvent, ITerminalShellIntegration } from './terminal.js';

/** Publishes Rust-owned command metadata only after the associated output is committed to the screen. */
export class AhpTerminalCommandSource extends Disposable {
	private readonly metadataChanged = this._register(new Emitter<void>());
	readonly onDidChangeMetadata = this.metadataChanged.event;
	private readonly commandStatusEmitter = this._register(new Emitter<ITerminalCommandStatusEvent>());
	readonly onDidChangeCommandStatus = this.commandStatusEmitter.event;
	private readonly pendingCommandEvents: ITerminalProcessCommandStatusEvent[] = [];
	private readonly pendingCwds: NonNullable<ITerminalProcessReadResult['cwd']>[] = [];
	private committedCwdSequence = -1;
	readonly cwdDetection = this._register(new CwdDetectionCapability());
	readonly promptTypeDetection = this._register(new PromptTypeDetectionCapability());
	private pendingShellIntegration: ITerminalProcessReadResult['shellIntegration'];
	private currentShellIntegration: ITerminalShellIntegration | undefined;
	get shellIntegration(): ITerminalShellIntegration | undefined {
		return this.currentShellIntegration;
	}
	get cwd(): string | undefined {
		return this.cwdDetection.getCwd() || undefined;
	}
	/** Earliest boundary, including metadata paginated ahead of its display bytes. */
	get nextBoundarySequence(): number {
		return Math.min(
			this.pendingCommandEvents[0]?.afterOutputSequence ?? Infinity,
			this.pendingCwds[0]?.afterOutputSequence ?? Infinity,
			this.pendingShellIntegration?.afterOutputSequence ?? Infinity,
		);
	}

	receive(result: Pick<ITerminalProcessReadResult, 'cwd' | 'shellIntegration' | 'commandEvents'> & Partial<Pick<ITerminalProcessReadResult, 'chunks'>>): void {
		// A read's snapshot contains only its final cwd. Preserve ordered boundaries
		// so consumers also observe directories visited between two reads.
		for (const chunk of result.chunks ?? []) {
			if (chunk.shellIntegration?.type === 'cwd')
				this.pendingCwds.push({
					value: chunk.shellIntegration.value,
					isTrusted: chunk.shellIntegration.isTrusted,
					afterOutputSequence: chunk.sequence,
				});
		}
		if (result.cwd) this.pendingCwds.push(result.cwd);
		this.pendingCwds.sort((a, b) => a.afterOutputSequence - b.afterOutputSequence);
		if (result.shellIntegration) this.pendingShellIntegration = result.shellIntegration;
		this.pendingCommandEvents.push(...result.commandEvents);
	}

	protected override disposeCore(): void {
		this.pendingCommandEvents.length = 0;
		this.pendingCwds.length = 0;
		this.pendingShellIntegration = undefined;
		super.disposeCore();
	}
	commitThrough(sequence: number, token: CancellationToken): void {
		let changed = false;
		while (!token.isCancellationRequested && this.pendingCwds.length && this.pendingCwds[0]!.afterOutputSequence <= sequence) {
			const cwd = this.pendingCwds.shift()!;
			if (cwd.afterOutputSequence <= this.committedCwdSequence) continue;
			this.committedCwdSequence = cwd.afterOutputSequence;
			this.currentShellIntegration = {
				commandDetection: false,
				hasRichCommandDetection: false,
				commandStorageDisabled: false,
				commands: [],
				...this.currentShellIntegration,
				cwdDetection: true,
			};
			this.cwdDetection.updateCwd(cwd.value, cwd.isTrusted);
			this.metadataChanged.fire();
		}
		if (!token.isCancellationRequested && this.pendingShellIntegration && this.pendingShellIntegration.afterOutputSequence <= sequence) {
			const integration = this.pendingShellIntegration;
			if (integration.promptType !== undefined && integration.promptType !== this.promptTypeDetection.promptType) {
				this.promptTypeDetection.setPromptType(integration.promptType);
			}
			this.currentShellIntegration = {
				commandDetection: integration.commandDetection,
				cwdDetection: integration.cwdDetection,
				hasRichCommandDetection: integration.hasRichCommandDetection,
				commandStorageDisabled: integration.commandStorageDisabled,
				// A full snapshot can withdraw prompt detection. The capability may
				// retain its last value, but it cannot override the execution owner.
				promptType: integration.promptType,
				commands: integration.commands.map(commandStatusEvent),
			};
			this.pendingShellIntegration = undefined;
			changed = true;
		}
		if (changed) this.metadataChanged.fire();
		while (!token.isCancellationRequested && this.pendingCommandEvents.length > 0 && this.pendingCommandEvents[0]!.afterOutputSequence <= sequence) {
			const event = this.pendingCommandEvents.shift()!;
			this.commandStatusEmitter.fire(commandStatusEvent(event));
		}
	}
}

function commandStatusEvent(event: ITerminalProcessCommandStatusEvent): ITerminalCommandStatusEvent {
	return {
		commandId: event.commandId,
		status: event.status,
		exitCode: event.exitCode,
		...(event.cwd === undefined ? {} : { cwd: event.cwd }),
		...(event.command === undefined ? {} : { command: event.command }),
		...(event.isTrusted === undefined ? {} : { isTrusted: event.isTrusted }),
	};
}
