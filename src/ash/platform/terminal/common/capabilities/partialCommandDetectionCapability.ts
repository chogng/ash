import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { TerminalCapability, type IMarkProperties, type IPartialCommandDetectionCapability } from './capabilities.js';

type Marker = NonNullable<IMarkProperties['marker']>;

/** Fallback navigation positions from Enter input, without guessing command text or exit status. */
export class PartialCommandDetectionCapability extends Disposable implements IPartialCommandDetectionCapability {
	readonly type = TerminalCapability.PartialCommandDetection;
	private readonly markers = new Map<number, Marker>();
	private readonly lifetimes = this._register(new DisposableMap<number, DisposableStore>());
	private readonly finished = this._register(new Emitter<Marker>());
	readonly onCommandFinished = this.finished.event;
	get commands(): readonly Marker[] { return [...this.markers.values()]; }

	constructor(private readonly terminal: {
		readonly buffer: { readonly active: { readonly type: string; readonly cursorX: number; readonly baseY: number; }; };
		onData(listener: (data: string) => void): { dispose(): void; };
		registerMarker(offset: number): Marker | undefined;
		readonly parser: { registerCsiHandler(id: { final: string; }, handler: (params: (number | number[])[]) => boolean): { dispose(): void; }; };
	}, onDidExecuteText: Event<void> | undefined) {
		super();
		const input = terminal.onData(data => { if (data === '\r') this.recordEnter(); });
		this._register(toDisposable(() => input.dispose()));
		const erase = terminal.parser.registerCsiHandler({ final: 'J' }, params => {
			if (params[0] === 2 || params[0] === 3) {
				for (const marker of this.commands) {
					if (params[0] === 3 || marker.line >= terminal.buffer.active.baseY) this.lifetimes.deleteAndDispose(marker.id);
				}
			}
			return false;
		});
		this._register(toDisposable(() => erase.dispose()));
		if (onDidExecuteText) this._register(onDidExecuteText(() => this.recordEnter()));
	}

	private recordEnter(): void {
		if (this.terminal.buffer.active.type !== 'normal' || this.terminal.buffer.active.cursorX < 2) return;
		const marker = this.terminal.registerMarker(0);
		if (!marker || marker.isDisposed) return;
		const lifetime = new DisposableStore();
		this.markers.set(marker.id, marker);
		this.lifetimes.set(marker.id, lifetime);
		lifetime.add(toDisposable(() => this.markers.delete(marker.id)));
		const trimmed = marker.onDispose(() => this.lifetimes.deleteAndDispose(marker.id));
		lifetime.add(toDisposable(() => trimmed.dispose()));
		lifetime.add(toDisposable(() => marker.dispose()));
		this.finished.fire(marker);
	}

	clearCommands(): void { this.lifetimes.clearAndDisposeAll(); }
}
