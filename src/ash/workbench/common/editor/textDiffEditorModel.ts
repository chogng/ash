import type { IDiffEditorModel } from '../../../editor/common/editorCommon.js';
import type { ITextModel } from '../../../editor/common/model.js';
import { DiffEditorModel } from './diffEditorModel.js';
import type { BaseTextEditorModel } from './textEditorModel.js';

/** Supplies the live text pair consumed by the comparison widget and computation model. */
export class TextDiffEditorModel<T extends ITextModel = ITextModel> extends DiffEditorModel {
	constructor(
		override readonly originalModel: BaseTextEditorModel<T>,
		override readonly modifiedModel: BaseTextEditorModel<T>,
	) {
		super(originalModel, modifiedModel);
	}

	get textDiffEditorModel(): (IDiffEditorModel & { original: T; modified: T }) | undefined {
		const original = this.originalModel.textEditorModel;
		const modified = this.modifiedModel.textEditorModel;
		if (this.isDisposed() || !original || !modified) {
			return undefined;
		}
		return { original, modified };
	}

	isReadonly(): boolean {
		return this.modifiedModel.isReadonly();
	}
}
