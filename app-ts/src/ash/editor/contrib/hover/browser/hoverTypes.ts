import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import type { Position } from '../../../common/core/position.js';
import type { Range } from '../../../common/core/range.js';

export interface HoverAnchor {
	readonly position: Position;
	readonly target: HTMLElement | undefined;
	readonly source: 'mouse' | 'click' | 'keyboard';
}

export interface IHoverPart {
	readonly owner: IEditorHoverParticipant;
	readonly range: Range;
}

export interface IEditorHoverRenderContext {
	readonly container: HTMLElement;
	hide(): void;
	onContentsChanged(): void;
}

export interface IRenderedHoverParts extends IDisposable {
	focus(): void;
	/** A participant's own editor transaction must not dismiss its interactive controls. */
	isUpdatingEditor(): boolean;
}

export interface IEditorHoverParticipant {
	computeSync(anchor: HoverAnchor): IHoverPart[];
	renderHoverParts(context: IEditorHoverRenderContext, parts: IHoverPart[]): IRenderedHoverParts;
}

type HoverParticipantConstructor = new (editor: ICodeEditor) => IEditorHoverParticipant;

/** Contributions register behavior; each editor creates its own participants and owns their rendered parts. */
export const HoverParticipantRegistry = new class {
	private readonly participants: HoverParticipantConstructor[] = [];
	public register(participant: HoverParticipantConstructor): void { this.participants.push(participant); }
	public getAll(): readonly HoverParticipantConstructor[] { return this.participants; }
}();
