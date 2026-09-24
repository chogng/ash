import "./media/unusualLineTerminators.css";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { type TextDecorationCollection } from "../../../common/model/decorationCollection.js";

import { type TextModel } from "../../../common/model/textModel.js";
import { findUnusualLineTerminators } from "../common/unusualLineTerminatorRanges.js";
import { TrackedRangeStickiness } from '../../../common/model.js';

/** Highlights unusual Unicode line separators without changing the canonical LF model. */
export class UnusualLineTerminatorsController extends Disposable {
	private lastVersion = -1;

	constructor(private readonly model: TextModel, readonly decorations: TextDecorationCollection<void>) {
		super();
		if (decorations.textModel !== model) throw new TypeError("Stanza unusual line terminator dependencies must share a text model");
		this._register(model.onDidChangeContent(() => this.update()));
		this.update();
	}

	private update(): void {
		if (this.lastVersion === this.model.version) return;
		this.lastVersion = this.model.version;
		this.decorations.replaceAll(findUnusualLineTerminators(this.model).map(range => ({
			range,
			stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			options: {
				description: 'unusual-line-terminator',
				className: 'unusual-line-terminator',
				hoverMessage: { value: 'Unusual line terminator' },
			},
			metadata: undefined,
		})));
	}
}
