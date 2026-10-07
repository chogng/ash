import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { Range } from "../../../common/core/range.js";
import { type TextModel } from "../../../common/model/textModel.js";
import { EditorFoldingModel } from "./foldingModel.js";

/** Derives hidden physical lines from collapsed folding regions for visual consumers. */
export class EditorHiddenRangeModel extends Disposable {
	private readonly changeEmitter = this._register(new Emitter<void>());
	private ranges: readonly Range[] = [];

	readonly onDidChange: Event<void> = this.changeEmitter.event;

	constructor(private readonly textModel: TextModel, private readonly folding: EditorFoldingModel) {
		super();
		if (folding.model !== textModel) throw new TypeError("Hidden range and folding models must share one text model");
		this.rebuild();
		this._register(folding.onDidChange(() => this.rebuild()));
		this._register(textModel.onDidChangeContent(() => this.rebuild()));
	}

	get hiddenRanges(): readonly Range[] {
		return this.ranges;
	}

	private rebuild(): void {
		const ranges: Range[] = [];
		for (const region of this.folding.regions) {
			if (!region.collapsed) continue;
			const start = region.startLineIndex + 2;
			const end = Math.min(region.endLineIndex + 1, this.textModel.lineCount);
			if (start > end) continue;
			const previous = ranges[ranges.length - 1];
			if (previous && start <= previous.endLineNumber + 1) {
				ranges[ranges.length - 1] = new Range(previous.startLineNumber, 1, Math.max(previous.endLineNumber, end), 1);
			} else {
				ranges.push(new Range(start, 1, end, 1));
			}
		}
		if (ranges.length === this.ranges.length && ranges.every((range, index) => range.equalsRange(this.ranges[index]))) return;
		this.ranges = ranges;
		this.changeEmitter.fire();
	}
}
