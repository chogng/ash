import { text, h } from '../../../../../base/browser/dom.js';
import { EditContext } from './editContextFactory.js';

type DebugMarker = { readonly dispose: () => void };
type EventHandler = (this: unknown, event: Event) => unknown;

interface EditContextInit {
	readonly text?: string;
	readonly selectionStart?: number;
	readonly selectionEnd?: number;
}

interface EditContextEventHandlersEventMap {
	readonly textupdate: TextUpdateEvent;
	readonly textformatupdate: TextFormatUpdateEvent;
	readonly characterboundsupdate: CharacterBoundsUpdateEvent;
	readonly compositionstart: CompositionEvent;
	readonly compositionend: CompositionEvent;
}

interface TextUpdateEvent extends Event {
	readonly text: string;
	readonly updateRangeStart: number;
	readonly updateRangeEnd: number;
	readonly selectionStart: number;
	readonly selectionEnd: number;
}

interface TextFormatUpdateEvent extends Event {
	getTextFormats(): readonly unknown[];
}

interface CharacterBoundsUpdateEvent extends Event {
	readonly rangeStart: number;
	readonly rangeEnd: number;
}

interface BrowserEditContext extends EventTarget {
	readonly text: string;
	readonly selectionStart: number;
	readonly selectionEnd: number;
	readonly characterBoundsRangeStart: number;
	updateText(start: number, end: number, text: string): void;
	updateSelection(start: number, end: number): void;
	updateControlBounds(bounds: DOMRect): void;
	updateSelectionBounds(bounds: DOMRect): void;
	updateCharacterBounds(rangeStart: number, bounds: readonly DOMRect[]): void;
	attachedElements(): HTMLElement[];
	characterBounds(): DOMRect[];
}

/** Adds optional visual diagnostics around one browser EditContext without owning editor state. */
export class DebugEditContext {
	private readonly editContext: BrowserEditContext;
	private readonly document: Document;
	private readonly listeners = new Map<EventListenerOrEventListenerObject, EventListenerOrEventListenerObject>();
	private readonly textUpdate = new HandlerSlot('textupdate', this);
	private readonly textFormatUpdate = new HandlerSlot('textformatupdate', this);
	private readonly characterBoundsUpdate = new HandlerSlot('characterboundsupdate', this);
	private readonly compositionStart = new HandlerSlot('compositionstart', this);
	private readonly compositionEnd = new HandlerSlot('compositionend', this);
	private markers: DebugMarker[] = [];
	private debugging = true;
	private controlBounds: DOMRect | undefined;
	private selectionBounds: DOMRect | undefined;
	private characterBoundsValue: readonly DOMRect[] = [];

	constructor(window: Window, options?: EditContextInit) {
		this.document = window.document;
		const editContext = EditContext.create(window, options);
		if (
			typeof (editContext as Partial<BrowserEditContext>).characterBoundsRangeStart !== 'number'
			|| typeof editContext.updateControlBounds !== 'function'
			|| typeof editContext.updateSelectionBounds !== 'function'
			|| typeof editContext.updateCharacterBounds !== 'function'
			|| typeof (editContext as Partial<BrowserEditContext>).attachedElements !== 'function'
			|| typeof (editContext as Partial<BrowserEditContext>).characterBounds !== 'function'
		) {
			throw new TypeError('Debug EditContext requires the complete browser API');
		}
		this.editContext = editContext as BrowserEditContext;
	}

	get text(): string { return this.editContext.text; }
	get selectionStart(): number { return this.editContext.selectionStart; }
	get selectionEnd(): number { return this.editContext.selectionEnd; }
	get characterBoundsRangeStart(): number { return this.editContext.characterBoundsRangeStart; }

	get ontextupdate(): EventHandler | null { return this.textUpdate.value; }
	set ontextupdate(value: EventHandler | null) { this.textUpdate.value = value; }
	get ontextformatupdate(): EventHandler | null { return this.textFormatUpdate.value; }
	set ontextformatupdate(value: EventHandler | null) { this.textFormatUpdate.value = value; }
	get oncharacterboundsupdate(): EventHandler | null { return this.characterBoundsUpdate.value; }
	set oncharacterboundsupdate(value: EventHandler | null) { this.characterBoundsUpdate.value = value; }
	get oncompositionstart(): EventHandler | null { return this.compositionStart.value; }
	set oncompositionstart(value: EventHandler | null) { this.compositionStart.value = value; }
	get oncompositionend(): EventHandler | null { return this.compositionEnd.value; }
	set oncompositionend(value: EventHandler | null) { this.compositionEnd.value = value; }

	updateText(start: number, end: number, text: string): void {
		this.editContext.updateText(start, end, text);
		this.renderDebug();
	}

	updateSelection(start: number, end: number): void {
		this.editContext.updateSelection(start, end);
		this.renderDebug();
	}

	updateControlBounds(bounds: DOMRect): void {
		this.editContext.updateControlBounds(bounds);
		this.controlBounds = bounds;
		this.renderDebug();
	}

	updateSelectionBounds(bounds: DOMRect): void {
		this.editContext.updateSelectionBounds(bounds);
		this.selectionBounds = bounds;
		this.renderDebug();
	}

	updateCharacterBounds(rangeStart: number, bounds: DOMRect[]): void {
		this.editContext.updateCharacterBounds(rangeStart, bounds);
		this.characterBoundsValue = bounds;
		this.renderDebug();
	}

	attachedElements(): HTMLElement[] { return this.editContext.attachedElements(); }
	characterBounds(): DOMRect[] { return this.editContext.characterBounds(); }

	addEventListener<K extends keyof EditContextEventHandlersEventMap>(type: K, listener: (this: GlobalEventHandlers, event: EditContextEventHandlersEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void;
	addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void {
		if (!listener) return;
		const wrapped: EventListener = event => {
			if (this.debugging) {
				this.renderDebug();
				console.debug(`DebugEditContext.${type}`, event);
			}
			if (typeof listener === 'function') listener.call(this, event);
			else listener.handleEvent(event);
		};
		this.listeners.set(listener, wrapped);
		this.editContext.addEventListener(type, wrapped, options);
		this.renderDebug();
	}

	removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
		if (!listener) return;
		const wrapped = this.listeners.get(listener);
		if (!wrapped) return;
		this.editContext.removeEventListener(type, wrapped, options);
		this.listeners.delete(listener);
		this.renderDebug();
	}

	dispatchEvent(event: Event): boolean { return this.editContext.dispatchEvent(event); }

	startDebugging(): void {
		this.debugging = true;
		this.renderDebug();
	}

	endDebugging(): void {
		this.debugging = false;
		this.renderDebug();
	}

	renderDebug(): void {
		for (const marker of this.markers) marker.dispose();
		this.markers = [];
		if (!this.debugging || this.listeners.size === 0) return;
		if (this.controlBounds) this.markers.push(this.createRect(this.controlBounds, 'blue'));
		if (this.selectionBounds) this.markers.push(this.createRect(this.selectionBounds, 'red'));
		for (const bounds of this.characterBoundsValue) this.markers.push(this.createRect(bounds, 'green'));
		this.markers.push(this.createTextMarker());
	}

	private createRect(bounds: DOMRect, color: string): DebugMarker {
		const element = this.createMarker();
		element.style.outline = `2px solid ${color}`;
		element.style.inset = `${bounds.top}px auto auto ${bounds.left}px`;
		element.style.width = `${bounds.width}px`;
		element.style.height = `${bounds.height}px`;
		return appendMarker(this.document, element);
	}

	private createTextMarker(): DebugMarker {
		const element = this.createMarker();
		element.style.left = '60px';
		element.style.bottom = '50px';
		element.style.padding = '5px';
		element.style.whiteSpace = 'pre';
		element.style.font = '12px monospace';
		element.style.background = 'white';
		element.style.border = '1px solid black';
		const before = this.text.slice(0, this.selectionStart);
		const selected = this.text.slice(this.selectionStart, this.selectionEnd) || '|';
		element.append(text(this.document, before));
		const highlight = h(this.document, 'span');
		highlight.style.background = 'yellow';
		highlight.textContent = selected;
		element.append(highlight, text(this.document, this.text.slice(this.selectionEnd) + ' '));
		return appendMarker(this.document, element);
	}

	private createMarker(): HTMLDivElement {
		const element = h(this.document, 'div');
		element.className = 'debug-rect-marker';
		element.setAttribute('aria-hidden', 'true');
		element.style.position = 'absolute';
		element.style.zIndex = '2147483647';
		element.style.pointerEvents = 'none';
		return element;
	}
}

class HandlerSlot {
	private handler: EventHandler | null = null;

	constructor(private readonly type: keyof EditContextEventHandlersEventMap, private readonly target: DebugEditContext) {}

	get value(): EventHandler | null { return this.handler; }
	set value(handler: EventHandler | null) {
		if (this.handler) this.target.removeEventListener(this.type, this.handler);
		this.handler = handler;
		if (handler) this.target.addEventListener(this.type, handler);
	}
}

function appendMarker(document: Document, element: HTMLElement): DebugMarker {
	document.body.append(element);
	return { dispose: () => element.remove() };
}
