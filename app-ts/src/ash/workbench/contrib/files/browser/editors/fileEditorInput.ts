import { type URI } from '../../../../../base/common/uri.js';
import { isRemoteResource } from '../../../../../platform/remote/common/remote.js';
import { type EditorInput } from '../../../../services/editor/common/editorService.js';

export const FILE_EDITOR_INPUT_ID = 'workbench.editorInput.file';

export interface FileEditorInputOptions {
	readonly label?: string;
	readonly contentType?: string;
	readonly languageId?: string;
	readonly readOnly?: boolean;
}

/** File-specific editor identity retained in the restored editor working set. */
export class FileEditorInput implements EditorInput {
	readonly typeId = FILE_EDITOR_INPUT_ID;
	readonly label: string;
	readonly contentType: string | undefined;
	readonly languageId: string | undefined;
	readonly readOnly: boolean | undefined;
	readonly showBreadcrumbs = true;

	constructor(readonly resource: URI, options: FileEditorInputOptions = {}) {
		if (resource.scheme !== 'file' && !isRemoteResource(resource)) throw new TypeError('File editor input requires a file resource');
		this.label = options.label ?? decodeURIComponent(resource.path.split('/').pop() || resource.path);
		this.contentType = options.contentType;
		this.languageId = options.languageId;
		this.readOnly = options.readOnly;
	}
}
