import './media/unusualLineTerminators.css';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { type TextDecorationCollection } from '../../../common/model/decorationCollection.js';

import { type TextModel } from '../../../common/model/textModel.js';
import { findUnusualLineTerminators } from '../common/unusualLineTerminatorRanges.js';
import { TrackedRangeStickiness } from '../../../common/model.js';
import type { TextModelChange } from '../../../common/core/textChange.js';
import { Range } from '../../../common/core/range.js';

/** Highlights unusual Unicode line separators without changing the canonical LF model. */
export class UnusualLineTerminatorsController extends Disposable {
	private lastVersion = -1;

	constructor(private readonly model: TextModel, readonly decorations: TextDecorationCollection<void>) {
		super();
		if (decorations.textModel !== model) throw new TypeError('Stanza unusual line terminator dependencies must share a text model');
		this._register(model.onDidChangeContent(change => this.update(change)));
		this.update();
	}

	private update(change?: TextModelChange): void {
		if (this.lastVersion === this.model.version) return;
		this.lastVersion = this.model.version;
		// The model already moved the old marks. Check those characters and the
		// inserted text only; ordinary input never needs another document scan.
		const ranges = change ? this.decorations.decorations.map(value => value.range).filter(range => /^[\u0085\u2028\u2029]$/u.test(this.model.getValueInRange(range))) : [...findUnusualLineTerminators(this.model)];
		if (change) {
			let delta = 0;
			for (const edit of [...change.changes].sort((a, b) => a.rangeOffset - b.rangeOffset)) {
				for (const match of edit.text.matchAll(/[\u0085\u2028\u2029]/gu)) {
					const start = this.model.getPositionAt(edit.rangeOffset + delta + match.index);
					ranges.push(new Range(start.lineNumber, start.column, start.lineNumber, start.column + 1));
				}
				delta += edit.text.length - edit.rangeLength;
			}
		}
		const unique = new Map(ranges.map(range => [`${range.startLineNumber}:${range.startColumn}`, range]));
		this.decorations.replaceAll([...unique.values()].map(range => ({
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
