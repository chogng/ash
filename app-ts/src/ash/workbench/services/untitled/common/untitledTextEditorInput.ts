import type { Event } from '../../../../base/common/event.js';
import type { URI } from '../../../../base/common/uri.js';
import type { EditorInput } from '../../editor/common/editorService.js';
import type { IUntitledTextEditorModel } from './untitledTextEditorModel.js';

/** Editor-facing metadata borrows the draft model; closing one view does not close other views. */
export class UntitledTextEditorInput implements EditorInput {
	public static readonly ID = 'workbench.editors.untitledEditorInput';
	public readonly typeId = UntitledTextEditorInput.ID;
	public readonly resource: URI;

	constructor(private readonly model: IUntitledTextEditorModel) {
		this.resource = model.resource;
	}

	public get label(): string {
		return this.model.name;
	}

	public get initialText(): string {
		return this.model.initialValue;
	}

	public get languageId(): string | undefined {
		return this.model.getLanguageId();
	}

	public get onDidChangeLabel(): Event<void> {
		return this.model.onDidChangeName;
	}

	public async resolve(): Promise<IUntitledTextEditorModel> {
		await this.model.resolve();
		return this.model;
	}
}
