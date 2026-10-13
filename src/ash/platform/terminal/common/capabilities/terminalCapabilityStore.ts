import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { TerminalCapability, type ITerminalCapabilityImplMap, type ITerminalCapabilityStore, type TerminalCommandSnapshot } from './capabilities.js';

interface ShellIntegrationSnapshot {
	readonly commandDetection: boolean;
	readonly cwdDetection: boolean;
	readonly hasRichCommandDetection: boolean;
	readonly commandStorageDisabled: boolean;
	readonly commands: readonly TerminalCommandSnapshot[];
}

/** An immutable capability view over the original committed metadata; it never parses or stores commands. */
export class TerminalCapabilityStore extends Disposable implements ITerminalCapabilityStore {
	private readonly added = this._register(new Emitter<TerminalCapability>());
	private readonly removed = this._register(new Emitter<TerminalCapability>());
	readonly onDidAddCapability = this.added.event;
	readonly onDidRemoveCapability = this.removed.event;
	private readonly announced = new Set<TerminalCapability>();
	private readonly views: ITerminalCapabilityImplMap;

	constructor(
		private readonly read: () => ShellIntegrationSnapshot | undefined,
		readCwd: () => string | undefined,
		onDidChange: Event<void>,
		onCommandStatus: Event<TerminalCommandSnapshot>,
	) {
		super();
		this.views = {
			[TerminalCapability.CwdDetection]: { getCwd: () => readCwd() ?? '' },
			[TerminalCapability.CommandDetection]: {
				get commands() { return read()?.commands ?? []; },
				get hasRichCommandDetection() { return read()?.hasRichCommandDetection ?? false; },
				get commandStorageDisabled() { return read()?.commandStorageDisabled ?? false; },
				onCommandFinished: (listener, thisArgs, disposables) => onCommandStatus(event => {
					if (event.status !== 'running') listener.call(thisArgs, event);
				}, undefined, disposables),
			},
		};
		this._register(onDidChange(() => this.refresh()));
		this.refresh();
	}

	has(id: TerminalCapability): boolean {
		if (this.isDisposed) return false;
		const snapshot = this.read();
		return id === TerminalCapability.CwdDetection ? snapshot?.cwdDetection === true : snapshot?.commandDetection === true;
	}

	get<T extends TerminalCapability>(id: T): ITerminalCapabilityImplMap[T] | undefined {
		return this.has(id) ? this.views[id] : undefined;
	}

	private refresh(): void {
		for (const id of [TerminalCapability.CwdDetection, TerminalCapability.CommandDetection]) {
			const present = this.has(id);
			if (present === this.announced.has(id)) continue;
			if (present) { this.announced.add(id); this.added.fire(id); }
			else { this.announced.delete(id); this.removed.fire(id); }
		}
	}
}
