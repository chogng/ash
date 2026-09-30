import type { URI } from '../../../base/common/uri.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { EditorModel } from './editorModel.js';

/** Resolves binary resource metadata; byte decoding and rendering belong to the pane. */
export class BinaryEditorModel extends EditorModel {
	private size: number | undefined;

	constructor(
		readonly resource: URI,
		private readonly name: string,
		@IFileService private readonly files: IFileService,
	) {
		super();
	}

	getName(): string {
		return this.name;
	}

	getSize(): number | undefined {
		return this.size;
	}

	override async resolve(): Promise<void> {
		const stat = await this.files.stat(this.resource);
		// A cancelled open disposes the model while the file request can still finish.
		if (this.isDisposed()) {
			return;
		}
		this.size = stat.sizeBytes;
		await super.resolve();
	}
}
