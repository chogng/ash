import { ScrollType } from '../common/editorCommon.js';
import { Position } from '../common/core/position.js';
import { type ICodeEditor } from './editorBrowser.js';

/** Preserves the first visible visual row while editor content is reprojected. */
export class StableEditorScrollState {
	public static capture(
		editor: ICodeEditor,
	): StableEditorScrollState {
		const scrollTop = editor.getScrollTop();
		const contentHeight = editor.getContentHeight();
		const rawCursorPosition = editor.getPosition();
		const cursorPosition = rawCursorPosition ? Position.lift(rawCursorPosition) : null;
		if (scrollTop === 0 || editor.hasPendingScrollAnimation()) {
			return new StableEditorScrollState(
				scrollTop,
				contentHeight,
				null,
				0,
				cursorPosition,
			);
		}

		const visiblePosition = editor.getVisibleRanges()[0]?.getStartPosition() ?? null;
		const visiblePositionTop = visiblePosition ? editor.getTopForPosition(visiblePosition.lineNumber, visiblePosition.column) : 0;
		return new StableEditorScrollState(
			scrollTop,
			contentHeight,
			visiblePosition,
			scrollTop - visiblePositionTop,
			cursorPosition,
		);
	}

	public constructor(
		private readonly _initialScrollTop: number,
		private readonly _initialContentHeight: number,
		private readonly _visiblePosition: Position | null,
		private readonly _visiblePositionScrollDelta: number,
		private readonly _cursorPosition: Position | null,
	) {}

	/** Restores the captured top-row offset after the viewport layout changes. */
	public restore(editor: ICodeEditor): void {
		if (
			this._initialContentHeight === editor.getContentHeight() &&
			this._initialScrollTop === editor.getScrollTop()
		) {
			return;
		}
		if (!this._visiblePosition) return;

		const visiblePositionTop = editor.getTopForPosition(this._visiblePosition.lineNumber, this._visiblePosition.column);
		editor.setScrollTop(visiblePositionTop + this._visiblePositionScrollDelta);
	}

	/**
	 * Keeps the current cursor at the same relative vertical position after a
	 * model or visual-line projection change.
	 */
	public restoreRelativeVerticalPositionOfCursor(
		editor: ICodeEditor,
	): void {
		if (
			this._initialContentHeight === editor.getContentHeight() &&
			this._initialScrollTop === editor.getScrollTop()
		) {
			return;
		}

		const initialCursorPosition = this._cursorPosition;
		const currentCursorPosition = editor.getPosition();
		if (!initialCursorPosition || !currentCursorPosition) return;

		const initialTop = editor.getTopForLineNumber(initialCursorPosition.lineNumber);
		const currentTop = editor.getTopForLineNumber(currentCursorPosition.lineNumber);
		editor.setScrollTop(editor.getScrollTop() + currentTop - initialTop, ScrollType.Immediate);
	}
}

/** Preserves the last visible visual row while editor content is reprojected. */
export class StableEditorBottomScrollState {
	public static capture(editor: ICodeEditor): StableEditorBottomScrollState {
		const scrollTop = editor.getScrollTop();
		const contentHeight = editor.getContentHeight();
		if (editor.hasPendingScrollAnimation()) {
			return new StableEditorBottomScrollState(
				scrollTop,
				contentHeight,
				null,
				0,
			);
		}

		const visiblePosition = editor.getVisibleRanges().at(-1)?.getEndPosition() ?? null;
		const bottom = visiblePosition ? editor.getBottomForLineNumber(visiblePosition.lineNumber) : 0;
		return new StableEditorBottomScrollState(
			scrollTop,
			contentHeight,
			visiblePosition,
			bottom - scrollTop,
		);
	}

	public constructor(
		private readonly _initialScrollTop: number,
		private readonly _initialContentHeight: number,
		private readonly _visiblePosition: Position | null,
		private readonly _visiblePositionScrollDelta: number,
	) {}

	/** Restores the captured bottom-row offset after the viewport layout changes. */
	public restore(editor: ICodeEditor): void {
		if (
			this._initialContentHeight === editor.getContentHeight() &&
			this._initialScrollTop === editor.getScrollTop()
		) {
			return;
		}
		if (!this._visiblePosition) return;

		const bottom = editor.getBottomForLineNumber(this._visiblePosition.lineNumber);
		editor.setScrollTop(bottom - this._visiblePositionScrollDelta, ScrollType.Immediate);
	}
}
