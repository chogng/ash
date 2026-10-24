import { toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { Position } from '../../../common/core/position.js';
import type { Range } from '../../../common/core/range.js';
import type { Constructor } from '../../../../platform/instantiation/common/descriptors.js';

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

type HoverParticipantConstructor = Constructor<IEditorHoverParticipant>;

/** Contributions register behavior; each editor creates its own participants and owns their rendered parts. */
export const HoverParticipantRegistry = new class {
	private readonly participants: HoverParticipantConstructor[] = [];
	public register(participant: HoverParticipantConstructor): IDisposable {
		this.participants.push(participant);
		return toDisposable(() => { const index = this.participants.indexOf(participant); if (index >= 0) this.participants.splice(index, 1); });
	}
	public getAll(): readonly HoverParticipantConstructor[] { return this.participants; }
}();
