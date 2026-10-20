import { type TextModel } from "../../../common/model/textModel.js";
import { computeUnicodeHighlights, type UnicodeHighlight } from "../../../common/services/unicodeTextModelHighlighter.js";

export type { UnicodeHighlight, UnicodeHighlightKind } from "../../../common/services/unicodeTextModelHighlighter.js";

/** Finds editor-dangerous invisible, bidi-control, and likely confusable characters. */
export function findUnicodeHighlights(model: TextModel): readonly UnicodeHighlight[] {
	return computeUnicodeHighlights(model.createVersionedSnapshot());
}
