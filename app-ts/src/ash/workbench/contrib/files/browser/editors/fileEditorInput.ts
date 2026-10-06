import { Schemas } from '../../../../../base/common/network.js';
import { type URI } from '../../../../../base/common/uri.js';
import { isRemoteResource } from '../../../../../platform/remote/common/remote.js';
import { AbstractResourceEditorInput } from '../../../../common/editor/resourceEditorInput.js';

export const FILE_EDITOR_INPUT_ID = 'workbench.editorInput.file';

export interface FileEditorInputOptions {
	readonly label?: string;
	readonly contentType?: string;
	readonly languageId?: string;
	readonly readOnly?: boolean;
}

/** File-specific editor identity retained in the restored editor working set. */
export class FileEditorInput extends AbstractResourceEditorInput {
	readonly typeId = FILE_EDITOR_INPUT_ID;
	private readonly displayName: string | undefined;
	readonly contentType: string | undefined;
	readonly languageId: string | undefined;
	readonly readOnly: boolean | undefined;
	readonly showBreadcrumbs = true;

	constructor(resource: URI, options: FileEditorInputOptions = {}) {
		if (resource.scheme !== Schemas.file && !isRemoteResource(resource)) throw new TypeError('File editor input requires a file resource');
		super(resource);
		this.displayName = options.label;
		this.contentType = options.contentType;
		this.languageId = options.languageId;
		this.readOnly = options.readOnly;
	}

	public override getName(): string {
		return this.displayName ?? super.getName();
	}
}
