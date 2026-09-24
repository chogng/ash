import './media/debugBreakpointDecorations.css';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { MouseTargetType, type ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { type TextModel } from '../../../../editor/common/model/textModel.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { TextDecorationCollection, type TextDecorationId } from '../../../../editor/common/model/decorationCollection.js';
import { GlyphMarginLane, TrackedRangeStickiness } from '../../../../editor/common/model.js';
import { isRemoteResource } from '../../../../platform/remote/common/remote.js';
import { type IDebugBreakpoint, IDebugService } from '../../../services/debug/common/debugService.js';

/** Owns breakpoint decorations and gutter interaction for one text editor. */
export class BreakpointEditorContribution extends Disposable {
	private readonly decorations;
	private decorationIds: readonly TextDecorationId[] = Object.freeze([]);

	constructor(editor: Pick<ICodeEditor, 'onMouseDown' | 'getDomNode'>, model: TextModel, @IDebugService private readonly debugService: IDebugService) {
		super();
		const resource = model.uri;
		this.decorations = this._register(new TextDecorationCollection<IDebugBreakpoint>(model));
		if (resource.scheme !== 'file' && !isRemoteResource(resource)) return;
		this.updateDecorations();
		this._register(debugService.onDidChangeBreakpoints(() => this.updateDecorations()));
		this._register(editor.onMouseDown(event => {
			const target = event.target;
			if (target.type !== MouseTargetType.GUTTER_GLYPH_MARGIN || target.detail.glyphMarginLane !== GlyphMarginLane.Left || !target.position) return;
			event.event.preventDefault();
			event.event.stopPropagation();
			editor.getDomNode()?.focus({ preventScroll: true });
			this.debugService.toggleBreakpoint(resource, target.position.lineNumber);
		}));
	}

	private updateDecorations(): void {
		const model = this.decorations.textModel;
		const resource = model.uri;
		const breakpoints = this.debugService.breakpoints.filter(candidate =>
			candidate.resource.toString() === resource.toString()
			&& candidate.lineNumber >= 1
			&& candidate.lineNumber <= model.lineCount
		);
		this.decorationIds = this.decorations.deltaDecorations(this.decorationIds, breakpoints.map(breakpoint => ({
			range: Range.fromPositions(new Position(breakpoint.lineNumber, 1)),
			stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			options: breakpointDecoration(breakpoint),
			metadata: breakpoint,
		})));
	}
}

function breakpointDecoration(breakpoint: IDebugBreakpoint) {
	const label = `Remove breakpoint at line ${breakpoint.lineNumber}`;
	return {
		description: 'debug-breakpoint',
		glyphMarginClassName: ['ash-debug-breakpoint-gutter', breakpoint.enabled ? 'enabled' : 'disabled', breakpoint.verified ? 'verified' : 'unverified'].join(' '),
		glyphMargin: { position: GlyphMarginLane.Left, persistLane: true },
		glyphMarginHoverMessage: { value: breakpoint.message ?? label },
		zIndex: 10,
	};
}
