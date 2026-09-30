import type { IReference } from '../../../base/common/lifecycle.js';
import type { ITextModel } from '../../../editor/common/model.js';
import { BaseTextEditorModel } from './textEditorModel.js';

/** Owns one reference to provider content. Shared content is released by its reference owner. */
export class TextResourceEditorModel extends BaseTextEditorModel {
	constructor(reference: IReference<ITextModel>) {
		super(reference.object);
		this._register(reference);
	}
}
