import { Position } from "../../../common/core/position.js";
import { Range } from "../../../common/core/range.js";
import { type TextModel } from "../../../common/model/textModel.js";

/** Returns non-LF line-separator characters that survived model normalization. */
export function findUnusualLineTerminators(model: TextModel): readonly Range[] {
	const result: Range[] = [];
	for (let lineIndex = 0; lineIndex < model.lineCount; lineIndex += 1) {
		const line = model.getLineContent((lineIndex) + 1);
		let columnIndex = 0;
		for (const character of line) {
			const codePoint = character.codePointAt(0)!;
			if (codePoint === 0x2028 || codePoint === 0x2029 || codePoint === 0x0085) result.push(Range.fromPositions(new Position((lineIndex) + 1, (columnIndex) + 1), new Position((lineIndex) + 1, (columnIndex + character.length) + 1)));
			columnIndex += character.length;
		}
	}
	return Object.freeze(result);
}
