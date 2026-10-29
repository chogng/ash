import { Emitter } from '../../../../base/common/event.js';
import type { Event } from '../../../../base/common/event.js';
import { EditorPane } from './editorPane.js';
import type { Selection } from '../../../../editor/common/core/selection.js';
import { TextEditorSelectionSource } from '../../../../platform/editor/common/editor.js';
import {
	EditorPaneSelectionChangeReason,
	type EditorPaneStatus,
	type IEditorControl,
	type IEditorPaneScrollPosition,
	type IEditorPaneWithScrolling,
} from '../../../common/editor.js';

export function toEditorPaneSelectionChangeReason(source: string): EditorPaneSelectionChangeReason {
	switch (source) {
		case TextEditorSelectionSource.PROGRAMMATIC:
			return EditorPaneSelectionChangeReason.PROGRAMMATIC;
		case TextEditorSelectionSource.NAVIGATION:
			return EditorPaneSelectionChangeReason.NAVIGATION;
		case TextEditorSelectionSource.JUMP:
			return EditorPaneSelectionChangeReason.JUMP;
		default:
			return EditorPaneSelectionChangeReason.USER;
	}
}

/** Selection details shared by text-based Workbench panes. */
export interface ITextEditorControl extends IEditorControl {
	getSelections?(): Selection[] | null;
	readonly onDidScrollChange?: Event<{ readonly scrollTopChanged: boolean; readonly scrollLeftChanged: boolean }>;
	getScrollTop?(): number;
	getScrollLeft?(): number;
	setScrollPosition?(position: IEditorPaneScrollPosition): void;
	setScrollTop?(scrollTop: number): void;
	setScrollLeft?(scrollLeft: number): void;
}

/** Owns the status reported by a text editor to the Workbench. */
export abstract class AbstractTextEditor<T extends ITextEditorControl>
	extends EditorPane
	implements IEditorPaneWithScrolling
{
	protected readonly scrollChangeEmitter = this._register(new Emitter<void>());
	readonly onDidChangeScroll = this.scrollChangeEmitter.event;
	protected readonly statusChangeEmitter = this._register(new Emitter<void>());
	protected languageId: string | undefined;
	readonly onDidChangeStatus = this.statusChangeEmitter.event;

	public abstract getControl(): T | undefined;

	getScrollPosition(): IEditorPaneScrollPosition {
		const control = this.getControl();
		return { scrollTop: control?.getScrollTop?.() ?? 0, scrollLeft: control?.getScrollLeft?.() };
	}

	setScrollPosition(position: IEditorPaneScrollPosition): void {
		const control = this.getControl();
		if (control?.setScrollPosition) {
			control.setScrollPosition(position);
		} else {
			control?.setScrollTop?.(position.scrollTop);
			if (position.scrollLeft !== undefined) control?.setScrollLeft?.(position.scrollLeft);
		}
	}

	getStatus(): EditorPaneStatus {
		const selections = this.getControl()?.getSelections?.();
		const active = selections?.[0]?.getPosition();
		return Object.freeze({
			...(active ? { lineNumber: active.lineNumber, columnNumber: active.column } : {}),
			...(selections && selections.length > 1 ? { selectionCount: selections.length } : {}),
			...(this.languageId ? { languageId: this.languageId } : {}),
			encoding: 'UTF-8',
			endOfLine: 'LF',
		});
	}
}
