import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IFileLabelDecoration, IFileLabelDecorationChangeEvent, IFileLabelDecorationService } from '../common/fileLabelDecorationService.js';

/** Mutable in-window store used by Workbench label consumers. */
export class FileLabelDecorationService extends Disposable implements IFileLabelDecorationService {
	private readonly decorations = new Map<string, IFileLabelDecoration>();
	private readonly changeEmitter = this._register(new Emitter<IFileLabelDecorationChangeEvent>());

	readonly onDidChange = this.changeEmitter.event;

	getDecoration(resource: URI, _isFolder: boolean): IFileLabelDecoration | undefined {
		return this.decorations.get(resource.toString());
	}

	setDecoration(resource: URI, decoration: IFileLabelDecoration): void {
		if (!decoration || typeof decoration !== 'object') throw new TypeError('File label decoration must be an object');
		this.decorations.set(resource.toString(), Object.freeze({ ...decoration }));
		this.changeEmitter.fire({ resources: [resource] });
	}

	clearDecoration(resource: URI): void {
		if (!this.decorations.delete(resource.toString())) return;
		this.changeEmitter.fire({ resources: [resource] });
	}
}
