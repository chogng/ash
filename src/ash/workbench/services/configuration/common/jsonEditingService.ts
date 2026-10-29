import { Disposable } from '../../../../base/common/lifecycle.js';
import { parseJsonc } from '../../../../base/common/jsonc.js';
import { setProperty } from '../../../../base/common/jsonEdit.js';
import { dirname } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import {
	IFileService,
	FileSystemProviderErrorCode,
	toFileSystemProviderErrorCode,
} from '../../../../platform/files/common/files.js';
import { IFileTextModelService } from '../../textmodelResolver/common/textModelResourceService.js';
import { IWorkingCopyService } from '../../workingCopy/common/workingCopyService.js';
import { localize } from '../../../../nls.js';
import { IJSONEditingService, JSONEditingError, JSONEditingErrorCode, type IJSONValue } from './jsonEditing.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

/** Edits the existing file model so editor content, dirty state and revision checks share one owner. */
class JSONEditingService extends Disposable implements IJSONEditingService {
	private pending: Promise<void> = Promise.resolve();
	constructor(
		@IFileService private readonly files: IFileService,
		@IFileTextModelService private readonly models: IFileTextModelService,
		@IWorkingCopyService private readonly copies: IWorkingCopyService,
	) {
		super();
	}

	write(resource: URI, values: IJSONValue[], save: boolean): Promise<void> {
		const result = this.pending.then(() => this.edit(resource, values, save));
		this.pending = result.catch(() => undefined);
		return result;
	}

	private async edit(resource: URI, values: IJSONValue[], save: boolean): Promise<void> {
		if (this.copies.get(resource).some(copy => copy.isDirty)) {
			throw new Error(
				localize(
					'jsonEditing.dirty',
					'Save or revert unsaved changes in {0} before updating it.',
					resource.toString(),
				),
			);
		}
		let initialText: string | undefined;
		try {
			await this.files.stat(resource);
		} catch (error) {
			if (toFileSystemProviderErrorCode(error as Error) !== FileSystemProviderErrorCode.FileNotFound) throw error;
			await this.files.createDirectory(dirname(resource));
			initialText = '{}\n';
		}
		using reference = await this.models.acquire(
			{ resource, initialText, languageId: 'jsonc' },
			new AbortController().signal,
		);
		if (reference.isDirty)
			throw new Error(
				localize(
					'jsonEditing.dirty',
					'Save or revert unsaved changes in {0} before updating it.',
					resource.toString(),
				),
			);
		const model = reference.model;
		let text = model.getValue();
		try {
			parseJsonc(text, resource.toString());
		} catch {
			throw new JSONEditingError(
				localize(
					'jsonEditing.invalid',
					'Cannot update {0} because it contains invalid JSON.',
					resource.toString(),
				),
				JSONEditingErrorCode.ERROR_INVALID_FILE,
			);
		}
		for (const value of values) {
			for (const edit of [
				...setProperty(text, value.path, value.value, {
					insertSpaces: true,
					tabSize: 2,
					eol: text.includes('\r\n') ? '\r\n' : '\n',
				}),
			].sort((a, b) => b.offset - a.offset)) {
				text = text.slice(0, edit.offset) + edit.content + text.slice(edit.offset + edit.length);
			}
		}
		if (text === model.getValue()) return;
		model.pushEditOperations(null, [{ range: model.getFullModelRange(), text }], () => null);
		if (save) await reference.save(new AbortController().signal);
	}
}
registerSingleton(IJSONEditingService, JSONEditingService, InstantiationType.Delayed);
