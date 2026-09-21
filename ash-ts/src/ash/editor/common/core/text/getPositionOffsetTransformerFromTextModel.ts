import type { ITextModel } from '../../model.js';
import { Position } from '../position.js';
import { PositionOffsetTransformerBase } from './positionToOffsetImpl.js';

/** Uses the model's current buffer coordinates; callers must not retain it as a snapshot. */
export function getPositionOffsetTransformerFromTextModel(textModel: ITextModel): PositionOffsetTransformerBase {
	return new ModelCoordinates(textModel);
}

class ModelCoordinates extends PositionOffsetTransformerBase {
	constructor(private readonly model: ITextModel) {
		super();
	}

	public override getOffset(position: Position): number {
		return this.model.getOffsetAt(position);
	}

	public override getPosition(offset: number): Position {
		return this.model.getPositionAt(offset);
	}
}
