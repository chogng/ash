import { Disposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import type { EditorInput } from '../../../services/editor/common/editorService.js';
import type { TextModelReference } from '../../../services/textmodelResolver/common/textModelResourceService.js';
import { ITextFileService } from '../../../services/textfile/common/textFileService.js';
import { IWorkingCopyService, type IWorkingCopy } from '../../../services/workingCopy/common/workingCopyService.js';

/** Borrows the canonical text state; changing editor types must not create another document. */
export class CustomTextEditorModel extends Disposable implements IWorkingCopy {
	public readonly backupKind = 'text' as const;
	public readonly resource: URI;
	public readonly backupLabel: string | undefined;
	public readonly backupLanguageId: string | undefined;
	public readonly onDidChangeDirty: IWorkingCopy['onDidChangeDirty'];
	public readonly onDidChangeExternalChange: IWorkingCopy['onDidChangeExternalChange'];
	public readonly onDidChangeContent: IWorkingCopy['onDidChangeContent'];

	constructor(
		public readonly reference: TextModelReference,
		input: EditorInput,
		private readonly saveUntitled: (() => Promise<void | boolean>) | undefined,
		@ITextFileService private readonly files: ITextFileService,
		@IWorkingCopyService workingCopies: IWorkingCopyService,
	) {
		super();
		this._register(reference);
		this.resource = input.resource;
		this.backupLabel = input.label;
		this.backupLanguageId = input.languageId;
		this.onDidChangeDirty = reference.onDidChangeDirty;
		this.onDidChangeExternalChange = reference.onDidChangeExternalChange;
		this.onDidChangeContent = listener => reference.model.onDidChangeContent(() => listener());
		this._register(workingCopies.register(this));
	}

	public get isDirty(): boolean { return this.reference.isDirty; }
	public get hasExternalChange(): boolean { return this.reference.hasExternalChange; }
	public backup(): string { return this.reference.model.getText(); }
	public restoreBackup(content: string): void { this.reference.model.reset(content); }
	public async save(signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (this.resource.scheme === 'untitled') {
			if (!this.saveUntitled) {
				throw new Error('Untitled custom editor requires a save handler');
			}
			await this.saveUntitled();
		} else {
			await this.reference.save(signal);
		}
	}

	public async saveAs(resource: URI, signal: AbortSignal): Promise<void> {
		await this.files.save({ resource, text: this.reference.model.getText() }, signal);
	}
	public revert(signal: AbortSignal): Promise<void> { return this.reference.revert(signal); }
}
