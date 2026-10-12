import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { ITerminalStatusList } from '../../../services/terminal/browser/terminal.js';
import type { ITerminalStatus } from '../../../services/terminal/common/terminal.js';

/** Owns display messages, never the process lifecycle that produced them. */
export class TerminalStatusList extends Disposable implements ITerminalStatusList {
	private readonly messages = new Map<string, ITerminalStatus>();
	private readonly primaryChanged = this._register(new Emitter<ITerminalStatus | undefined>());
	readonly onDidChangePrimaryStatus = this.primaryChanged.event;

	get statuses(): readonly ITerminalStatus[] { return [...this.messages.values()]; }
	get primary(): ITerminalStatus | undefined {
		let primary: ITerminalStatus | undefined;
		for (const status of this.messages.values()) {
			if (!primary || status.severity >= primary.severity) primary = status;
		}
		return primary;
	}

	add(status: ITerminalStatus): void {
		const previous = this.primary;
		this.messages.set(status.id, status);
		if (this.primary !== previous) this.primaryChanged.fire(this.primary);
	}

	remove(status: ITerminalStatus | string): void {
		const previous = this.primary;
		this.messages.delete(typeof status === 'string' ? status : status.id);
		if (this.primary !== previous) this.primaryChanged.fire(this.primary);
	}

	protected override disposeCore(): void {
		this.messages.clear();
		super.disposeCore();
	}
}
