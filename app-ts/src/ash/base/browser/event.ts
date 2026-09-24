import { Emitter, type Event as BaseEvent } from '../common/event.js';
import { AbstractDisposable, setDisposableOwner } from '../common/lifecycle.js';

type DomListenerOptions = boolean | AddEventListenerOptions;

/** Browser event names shared by HTML elements, documents, and windows. */
export interface DOMEventMap extends HTMLElementEventMap, DocumentEventMap, WindowEventMap {}

/** Exposes one native DOM event through the common disposable Event contract. */
export class DomEmitter<K extends keyof DOMEventMap> extends AbstractDisposable {
	private readonly emitter: Emitter<DOMEventMap[K]>;

	public get event(): BaseEvent<DOMEventMap[K]> {
		return this.emitter.event;
	}

	constructor(target: EventTarget, type: K, options?: DomListenerOptions) {
		super();
		const listener = (event: Event): void => this.emitter.fire(event as DOMEventMap[K]);
		this.emitter = new Emitter<DOMEventMap[K]>({
			onWillAddFirstListener: () => target.addEventListener(type, listener, options),
			onDidRemoveLastListener: () => target.removeEventListener(type, listener, options),
		});
		setDisposableOwner(this.emitter, this);
	}

	protected override disposeCore(): void {
		this.emitter.dispose();
	}
}
