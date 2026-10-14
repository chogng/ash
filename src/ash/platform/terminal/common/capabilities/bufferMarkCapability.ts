import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { TerminalCapability, type IBufferMarkCapability, type IMarkProperties } from './capabilities.js';

interface MarkRegistration {
	readonly marker: NonNullable<IMarkProperties['marker']>;
	readonly lifetime: DisposableStore;
}

/** Indexes marks on one xterm screen and owns only the markers it creates. */
export class BufferMarkCapability extends Disposable implements IBufferMarkCapability {
	readonly type = TerminalCapability.BufferMarkDetection;
	private readonly added = this._register(new Emitter<IMarkProperties>());
	readonly onMarkAdded = this.added.event;
	private readonly registrations = new Map<string | number, MarkRegistration>();

	constructor(private readonly terminal: { registerMarker(cursorYOffset?: number): IMarkProperties['marker']; }) { super(); }

	*markers(): IterableIterator<NonNullable<IMarkProperties['marker']>> {
		for (const { marker } of this.registrations.values()) yield marker;
	}

	getMark(id: string): IMarkProperties['marker'] { return this.registrations.get(id)?.marker; }

	addMark(properties: IMarkProperties = {}): void {
		if (this.isDisposed) return;
		const marker = properties.marker ?? this.terminal.registerMarker(0);
		if (!marker || marker.isDisposed) return;
		const key = properties.id || marker.id;
		this.registrations.get(key)?.lifetime.dispose();
		const lifetime = new DisposableStore();
		const registration = { marker, lifetime };
		this.registrations.set(key, registration);
		lifetime.add(toDisposable(() => {
			if (this.registrations.get(key) === registration) this.registrations.delete(key);
		}));
		lifetime.add(Event.once<void>(listener => {
			const subscription = marker.onDispose(listener);
			return toDisposable(() => subscription.dispose());
		})(() => lifetime.dispose()));
		if (!properties.marker) lifetime.add(toDisposable(() => marker.dispose()));
		this.added.fire({ ...properties, marker });
	}

	protected override disposeCore(): void {
		for (const { lifetime } of [...this.registrations.values()]) lifetime.dispose();
		super.disposeCore();
	}
}
