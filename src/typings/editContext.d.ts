// Browser EditContext contracts used by the editor, absent from TypeScript 5.9's DOM library.
interface EditContextInit {
	text?: string;
	selectionStart?: number;
	selectionEnd?: number;
}

interface EditContext extends EventTarget {
	readonly text: string;
	readonly selectionStart: number;
	readonly selectionEnd: number;
	updateText(rangeStart: number, rangeEnd: number, text: string): void;
	updateSelection(start: number, end: number): void;
	updateControlBounds(bounds: DOMRect): void;
	updateSelectionBounds(bounds: DOMRect): void;
	updateCharacterBounds(rangeStart: number, bounds: DOMRect[]): void;
}

interface TextUpdateEvent extends Event {
	readonly text: string;
	readonly updateRangeStart: number;
	readonly updateRangeEnd: number;
	readonly selectionStart: number;
	readonly selectionEnd: number;
}

interface CharacterBoundsUpdateEvent extends Event {
	readonly rangeStart: number;
	readonly rangeEnd: number;
}

interface TextFormat {
	readonly rangeStart: number;
	readonly rangeEnd: number;
	readonly underlineStyle: 'none' | 'solid' | 'dotted' | 'dashed' | 'wavy';
	readonly underlineThickness: 'none' | 'thin' | 'thick';
}

interface TextFormatUpdateEvent extends Event {
	getTextFormats(): TextFormat[];
}

interface EditContextEventHandlersEventMap {
	textupdate: TextUpdateEvent;
	textformatupdate: TextFormatUpdateEvent;
	characterboundsupdate: CharacterBoundsUpdateEvent;
	compositionstart: Event;
	compositionend: Event;
}

interface Window {
	readonly EditContext?: { new(options?: EditContextInit): EditContext };
}

interface HTMLElement {
	editContext?: EditContext | null;
}
