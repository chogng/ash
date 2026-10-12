import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { ITerminalProcessReadResult, ITerminalProcessCommandStatusEvent } from '../../../../platform/terminal/common/terminal.js';
import type { ITerminalCommandStatusEvent, ITerminalShellIntegration } from '../../../services/terminal/browser/terminal.js';

/** Publishes Rust-owned command metadata only after the associated output is committed to the screen. */
export class AhpTerminalCommandSource extends Disposable {
	private readonly metadataChanged = this._register(new Emitter<void>());
	readonly onDidChangeMetadata = this.metadataChanged.event;
 private readonly commandStatusEmitter = this._register(new Emitter<ITerminalCommandStatusEvent>());
 readonly onDidChangeCommandStatus = this.commandStatusEmitter.event;
 private readonly pendingCommandEvents: ITerminalProcessCommandStatusEvent[] = [];
 private pendingCwd: ITerminalProcessReadResult['cwd'];
 private currentCwd: string | undefined;
 private pendingShellIntegration: ITerminalProcessReadResult['shellIntegration'];
 private currentShellIntegration: ITerminalShellIntegration | undefined;
 get shellIntegration(): ITerminalShellIntegration | undefined { return this.currentShellIntegration; }
 get cwd(): string | undefined { return this.currentCwd; }

 receive(result: Pick<ITerminalProcessReadResult, 'cwd' | 'shellIntegration' | 'commandEvents'>): void {
  if (result.cwd) this.pendingCwd = result.cwd;
  if (result.shellIntegration) this.pendingShellIntegration = result.shellIntegration;
  this.pendingCommandEvents.push(...result.commandEvents);
 }

 protected override disposeCore(): void {
  this.pendingCommandEvents.length = 0;
  this.pendingCwd = undefined;
  this.pendingShellIntegration = undefined;
  super.disposeCore();
 }
	commitThrough(sequence: number, token: CancellationToken): void {
		let changed = false;
		if (!token.isCancellationRequested && this.pendingCwd && this.pendingCwd.afterOutputSequence <= sequence) {
			this.currentCwd = this.pendingCwd.value;
			this.pendingCwd = undefined;
			changed = true;
		}
		if (!token.isCancellationRequested && this.pendingShellIntegration && this.pendingShellIntegration.afterOutputSequence <= sequence) {
			const integration = this.pendingShellIntegration;
			this.currentShellIntegration = {
				commandDetection: integration.commandDetection,
				cwdDetection: integration.cwdDetection,
				hasRichCommandDetection: integration.hasRichCommandDetection,
				commandStorageDisabled: integration.commandStorageDisabled,
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
		commandId: event.commandId, status: event.status, exitCode: event.exitCode,
		...(event.cwd === undefined ? {} : { cwd: event.cwd }),
		...(event.command === undefined ? {} : { command: event.command }),
		...(event.isTrusted === undefined ? {} : { isTrusted: event.isTrusted }),
	};
}
