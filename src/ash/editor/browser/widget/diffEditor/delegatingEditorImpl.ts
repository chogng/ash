import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IPosition } from '../../../common/core/position.js';
import type { CodeEditorWidget } from '../codeEditor/codeEditorWidget.js';

/** Shared editor operations target the modified side of a composite editor. */
export abstract class DelegatingEditor extends Disposable {
	protected abstract get _targetEditor(): CodeEditorWidget;

	public focus(): void {
		this._targetEditor.focus();
	}

	public setPosition(position: IPosition, source = 'api'): void {
		this._targetEditor.setPosition(position, source);
	}
}
