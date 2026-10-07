import type { ITextModel } from '../model.js';
import { Range } from '../core/range.js';
import { AbstractText } from '../core/text/abstractText.js';
import { getPositionOffsetTransformerFromTextModel } from '../core/text/getPositionOffsetTransformerFromTextModel.js';
import { PositionOffsetTransformerBase } from '../core/text/positionToOffsetImpl.js';
import { TextLength } from '../core/text/textLength.js';

/** A live text view. Text and coordinates remain owned by the model. */
export class TextModelText extends AbstractText {
	private readonly coordinates: PositionOffsetTransformerBase;

	constructor(private readonly model: ITextModel) {
		super();
		this.coordinates = getPositionOffsetTransformerFromTextModel(model);
	}

	public override get length(): TextLength {
		return TextLength.ofRange(this.model.getFullModelRange());
	}

	public override getValueOfRange(range: Range): string {
		return this.model.getValueInRange(range);
	}

	public override getLineLength(lineNumber: number): number {
		return this.model.getLineLength(lineNumber);
	}

	public override getTransformer(): PositionOffsetTransformerBase {
		return this.coordinates;
	}
}
