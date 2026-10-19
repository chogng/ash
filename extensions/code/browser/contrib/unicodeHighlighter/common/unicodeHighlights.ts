import { type TextModel } from "../../../../../../src/ash/editor/common/model/textModel.js";
import { computeUnicodeHighlights, type UnicodeHighlight } from "../../../../../../src/ash/editor/common/services/unicodeTextModelHighlighter.js";

export type { UnicodeHighlight, UnicodeHighlightKind } from "../../../../../../src/ash/editor/common/services/unicodeTextModelHighlighter.js";

/** Finds editor-dangerous invisible, bidi-control, and likely confusable characters. */
export function findUnicodeHighlights(model: TextModel): readonly UnicodeHighlight[] {
	return computeUnicodeHighlights(model.createVersionedSnapshot());
}
