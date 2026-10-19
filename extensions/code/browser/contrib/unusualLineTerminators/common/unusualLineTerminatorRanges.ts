import { Position } from "../../../../../../src/ash/editor/common/core/position.js";
import { Range } from "../../../../../../src/ash/editor/common/core/range.js";
import { type TextModel } from "../../../../../../src/ash/editor/common/model/textModel.js";

/** Returns non-LF line-separator characters that survived model normalization. */
export function findUnusualLineTerminators(model: TextModel): readonly Range[] {
	const result: Range[] = [];
	const snapshot = model.createSnapshot();
	let offset = 0;
	for (let chunk = snapshot.read(); chunk !== null; chunk = snapshot.read()) {
		for (const match of chunk.matchAll(/[\u0085\u2028\u2029]/gu)) {
			const start = model.getPositionAt(offset + match.index);
			result.push(Range.fromPositions(start, new Position(start.lineNumber, start.column + 1)));
		}
		offset += chunk.length;
	}
	return Object.freeze(result);
}
