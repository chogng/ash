import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { ITerminalStatus } from '../common/terminal.js';

export const enum TerminalStatus {
	Disconnected = 'disconnected',
	ShellIntegrationInfo = 'shell-integration-info',
}

/** Display messages are independent of the instance's process and connection state. */
export interface ITerminalStatusList {
	readonly primary: ITerminalStatus | undefined;
	readonly statuses: readonly ITerminalStatus[];
	readonly onDidAddStatus: Event<ITerminalStatus>;
	readonly onDidRemoveStatus: Event<ITerminalStatus>;
	readonly onDidChangePrimaryStatus: Event<ITerminalStatus | undefined>;
	add(status: ITerminalStatus): void;
	remove(status: ITerminalStatus | string): void;
}

/** Owns display messages, never the process lifecycle that produced them. */
export class TerminalStatusList extends Disposable implements ITerminalStatusList {
	private readonly messages = new Map<string, ITerminalStatus>();
	private readonly added = this._register(new Emitter<ITerminalStatus>());
	private readonly removed = this._register(new Emitter<ITerminalStatus>());
	private readonly primaryChanged = this._register(new Emitter<ITerminalStatus | undefined>());
	readonly onDidAddStatus = this.added.event;
	readonly onDidRemoveStatus = this.removed.event;
	readonly onDidChangePrimaryStatus = this.primaryChanged.event;

	get statuses(): readonly ITerminalStatus[] {
		return [...this.messages.values()];
	}
	get primary(): ITerminalStatus | undefined {
		let primary: ITerminalStatus | undefined;
		for (const status of this.messages.values()) {
			if (!primary || status.severity >= primary.severity) primary = status;
		}
		return primary;
	}

	add(status: ITerminalStatus): void {
		const existing = this.messages.get(status.id);
		if (existing === status) {
			return;
		}
		const previous = this.primary;
		// Replacing a message also makes it the newest message at its severity.
		this.messages.delete(status.id);
		this.messages.set(status.id, status);
		if (existing) {
			this.removed.fire(existing);
		}
		this.added.fire(status);
		if (this.primary !== previous) this.primaryChanged.fire(this.primary);
	}

	remove(status: ITerminalStatus | string): void {
		const id = typeof status === 'string' ? status : status.id;
		const existing = this.messages.get(id);
		if (!existing) {
			return;
		}
		const previous = this.primary;
		this.messages.delete(id);
		this.removed.fire(existing);
		if (this.primary !== previous) this.primaryChanged.fire(this.primary);
	}

	protected override disposeCore(): void {
		this.messages.clear();
		super.disposeCore();
	}
}
