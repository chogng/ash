import type { IResolvableEditorModel } from '../../../platform/editor/common/editor.js';
import { EditorModel } from './editorModel.js';

/** A comparison borrows its sides; their inputs or host retain release ownership. */
export class DiffEditorModel extends EditorModel {
	constructor(
		readonly originalModel: IResolvableEditorModel | undefined,
		readonly modifiedModel: IResolvableEditorModel | undefined,
	) {
		super();
	}

	override async resolve(): Promise<void> {
		await Promise.all([this.originalModel?.resolve(), this.modifiedModel?.resolve()]);
	}

	override isResolved(): boolean {
		return !this.isDisposed() && this.originalModel?.isResolved() === true && this.modifiedModel?.isResolved() === true;
	}
}
