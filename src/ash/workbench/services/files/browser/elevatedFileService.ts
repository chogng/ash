import type { VSBuffer } from '../../../../base/common/buffer.js';
import type { URI } from '../../../../base/common/uri.js';
import { FileOperationNotSupportedError, type IFileWriteResult } from '../../../../platform/files/common/files.js';
import { IElevatedFileService } from '../common/elevatedFileService.js';

/** Browser directory handles confer user-selected access, never OS administrator rights. */
export class BrowserElevatedFileService implements IElevatedFileService {
	public isSupported(_resource: URI): boolean { return false; }

	public async writeFileElevated(resource: URI, _value: VSBuffer): Promise<IFileWriteResult> {
		throw new FileOperationNotSupportedError(resource, 'writeFileElevated');
	}
}
