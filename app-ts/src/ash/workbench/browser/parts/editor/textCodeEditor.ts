import type { IDimension } from '../../../../base/browser/dom.js';
import type { Range } from '../../../../editor/common/core/range.js';
import type { ICodeEditorViewState } from '../../../../editor/common/editorCommon.js';
import { AbstractTextEditor, type ITextEditorControl } from './textEditor.js';

/** Operations supplied by a code view hosted inside a text pane. */
export interface ITextCodeEditorControl extends ITextEditorControl {
	layout(dimension: IDimension): void;
	focus(): void;
	getValue(): string;
	revealRange?(range: Range): void;
	saveViewState?(): ICodeEditorViewState | null;
	restoreViewState?(state: ICodeEditorViewState): void;
}

/** Connects Workbench layout, focus, and view state to its active code view. */
export abstract class AbstractTextCodeEditor<T extends ITextCodeEditorControl> extends AbstractTextEditor<T> {
	protected dimension: IDimension = { width: 0, height: 0 };

	layout(dimension: IDimension): void {
		this.dimension = {
			width: Math.max(0, dimension.width),
			height: Math.max(0, dimension.height),
		};
		this.getControl()?.layout(this.dimension);
	}

	focus(): void {
		this.getControl()?.focus();
	}

	getValue(): string {
		return this.getControl()?.getValue() ?? '';
	}

	revealRange(range: Range): void {
		this.getControl()?.revealRange?.(range);
	}

	saveViewState(): unknown {
		return this.getControl()?.saveViewState?.();
	}

	restoreViewState(state: unknown): void {
		if (!isCodeEditorViewState(state)) throw new TypeError('Invalid code editor view state');
		const control = this.getControl();
		if (!control?.restoreViewState) throw new Error('Stanza code editor view-state restoration is unavailable');
		control.restoreViewState(state);
	}
}

function isCodeEditorViewState(value: unknown): value is ICodeEditorViewState {
	if (!value || typeof value !== 'object') return false;
	const state = value as Partial<ICodeEditorViewState>;
	return Array.isArray(state.cursorState)
		&& Boolean(state.viewState)
		&& typeof state.viewState?.scrollLeft === 'number'
		&& Boolean(state.viewState?.firstPosition);
}
