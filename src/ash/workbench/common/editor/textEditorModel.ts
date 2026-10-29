import type { ITextModel, ITextSnapshot } from '../../../editor/common/model.js';
import type { IResolvedTextEditorModel, ITextEditorModel } from '../../../editor/common/services/resolverService.js';
import { EditorModel } from './editorModel.js';

/** Borrows text from its existing owner; disposing this view never destroys that text. */
export class BaseTextEditorModel<T extends ITextModel = ITextModel> extends EditorModel implements ITextEditorModel {
	constructor(private readonly model: T, private readonly readOnly = true) {
		super();
		this._register(model.onWillDispose(() => this.dispose()));
	}

	get textEditorModel(): T | null {
		return this.isResolved() ? this.model : null;
	}

	override isResolved(): this is IResolvedTextEditorModel & this {
		return !this.isDisposed() && !this.model.isDisposed();
	}

	createSnapshot(this: IResolvedTextEditorModel): ITextSnapshot;
	createSnapshot(this: ITextEditorModel): ITextSnapshot | null;
	createSnapshot(): ITextSnapshot | null {
		return this.textEditorModel?.createSnapshot() ?? null;
	}

	isReadonly(): boolean {
		return this.readOnly;
	}

	getLanguageId(): string | undefined {
		return this.textEditorModel?.getLanguageId();
	}
}
