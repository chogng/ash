import { Disposable } from '../../../../base/common/lifecycle.js';
import { Range } from '../../../../editor/common/core/range.js';
import { GlyphMarginLane, TrackedRangeStickiness } from '../../../../editor/common/model.js';
import {
	TextDecorationCollection,
	type TextDecorationId,
} from '../../../../editor/common/model/decorationCollection.js';
import type { TextModel } from '../../../../editor/common/model/textModel.js';
import { IDebugService } from '../common/debug.js';
import './media/callStackEditorContribution.css';

/** Projects the window's selected paused frame; the model owns decoration tracking. */
export class CallStackEditorContribution extends Disposable {
	private readonly decorations: TextDecorationCollection<undefined>;
	private ids: readonly TextDecorationId[] = [];

	constructor(
		private readonly model: TextModel,
		@IDebugService private readonly debug: IDebugService,
	) {
		super();
		this.decorations = this._register(new TextDecorationCollection(model));
		this._register(debug.getViewModel().onDidFocusStackFrame(() => this.update()));
		this._register(debug.onDidChangeSession(() => this.update()));
		this._register(model.onDidChangeContent(() => this.update()));
		this.update();
	}

	private update(): void {
		const selection = this.debug.getViewModel();
		const frame = selection.focusedStackFrame;
		const resource = frame?.source?.resource;
		const current =
			this.debug.session?.state === 'stopped' &&
			selection.focusedSession === this.debug.session &&
			resource?.toString() === this.model.uri.toString() &&
			frame &&
			frame.lineNumber > 0 &&
			frame.lineNumber <= this.model.lineCount;
		this.ids = this.decorations.deltaDecorations(
			this.ids,
			current
				? [
						{
							range: new Range(
								frame.lineNumber,
								1,
								frame.lineNumber,
								this.model.getLineMaxColumn(frame.lineNumber),
							),
							stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
							options: {
								description: 'debug-stack-frame',
								isWholeLine: true,
								className: 'ash-debug-stack-frame',
								glyphMarginClassName: 'ash-debug-stack-frame-gutter',
								glyphMargin: { position: GlyphMarginLane.Right },
								zIndex: 5,
							},
							metadata: undefined,
						},
					]
				: [],
		);
	}
}
