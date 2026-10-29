import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { AnchorAxisAlignment, AnchorPosition } from '../../../../base/browser/ui/contextview/contextview.js';
import { IHoverService, type IManagedHover } from '../../../../platform/hover/browser/hoverService.js';
import { MouseTargetType, type ICodeEditor, type IEditorMouseEvent } from '../../../browser/editorBrowser.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { GlyphMarginLane } from '../../../common/model.js';

/** Reads margin decoration content without invoking language hover providers. */
export class GlyphHoverController extends Disposable {
	public static readonly ID = 'editor.contrib.marginHover';
	private readonly hover = this._register(new MutableDisposable<IManagedHover>());
	private readonly timer = this._register(new RunOnceScheduler(() => this.show(), 0));
	private pending: IEditorMouseEvent | undefined;

	constructor(
		private readonly editor: ICodeEditor,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();
		this._register(editor.onMouseMove(event => this.schedule(event)));
		this._register(editor.onMouseLeave(() => this.hide()));
		this._register(editor.onMouseDown(() => this.hide()));
		this._register(editor.onDidScrollChange(() => this.hide()));
		this._register(editor.onDidChangeModel(() => this.hide()));
		this._register(editor.onDidChangeModelContent(() => this.hide()));
		this._register(editor.onDidChangeConfiguration(() => this.hide()));
		this._register(editor.onKeyDown(() => this.hide()));
	}

	private schedule(event: IEditorMouseEvent): void {
		const target = event.target;
		const options = this.editor.getOption(EditorOption.hover);
		const modifier = this.editor.getOption(EditorOption.multiCursorModifier) === 'altKey' ? (isMacintosh ? event.event.metaKey : event.event.ctrlKey) : event.event.altKey;
		if (
			target.type !== MouseTargetType.GUTTER_GLYPH_MARGIN ||
			target.detail.isAfterLines ||
			event.event.buttons ||
			options.enabled === 'off' ||
			(options.enabled === 'onKeyboardModifier' && !modifier)
		) {
			this.hide();
			return;
		}
		const previous = this.pending?.target;
		if (previous?.type === target.type && previous.position.lineNumber === target.position.lineNumber && previous.detail.glyphMarginLane === target.detail.glyphMarginLane) {
			this.pending = event;
			return;
		}
		this.hide();
		this.pending = event;
		this.timer.schedule(options.delay);
	}

	private show(): void {
		const event = this.pending;
		const root = this.editor.getDomNode();
		if (!event || !root || event.target.type !== MouseTargetType.GUTTER_GLYPH_MARGIN) return;
		// A breakpoint preview can be painted after the original mouse move. Resolve
		// its current cell after the delay so the hover uses that cell's lane and bounds.
		const element = root.ownerDocument.elementFromPoint(event.event.clientX, event.event.clientY);
		const cell = element?.closest<HTMLElement>('.stanza-editor-glyph-margin-decoration');
		if (!cell || !root.contains(cell)) return;
		const lane = Number(cell.dataset.glyphMarginLane) as GlyphMarginLane;
		const messages = (this.editor.getLineDecorations(event.target.position.lineNumber) ?? []).flatMap(decoration => {
			if ((decoration.options.glyphMargin?.position ?? GlyphMarginLane.Center) !== lane) return [];
			const message = decoration.options.glyphMarginHoverMessage;
			return (Array.isArray(message) ? message : message ? [message] : []).map(value => value.value);
		});
		if (!messages.length) return;
		this.hover.value = this.hoverService.showHover({
			target: cell,
			content: messages.join('\n\n'),
			anchorAxisAlignment: AnchorAxisAlignment.Horizontal,
			anchorPosition: AnchorPosition.Below,
		});
	}

	private hide(): void {
		this.pending = undefined;
		this.timer.cancel();
		this.hover.clear();
	}
}
