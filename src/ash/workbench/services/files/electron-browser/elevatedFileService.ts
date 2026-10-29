import type { VSBuffer } from '../../../../base/common/buffer.js';
import type { URI } from '../../../../base/common/uri.js';
import { FileOperationNotSupportedError, FileSystemProviderCapabilities, IFileService, type IFileWriteOptions, type IFileWriteResult } from '../../../../platform/files/common/files.js';
import { IElevatedFileService } from '../common/elevatedFileService.js';

/** Rust owns the write and OS authorization process; the renderer owns no privileged filesystem state. */
export class ElectronElevatedFileService implements IElevatedFileService {
	constructor(@IFileService private readonly files: IFileService) { }

	public isSupported(resource: URI): boolean {
		return resource.scheme === 'file' && this.files.hasCapability(resource, FileSystemProviderCapabilities.FileWriteElevated);
	}

	public writeFileElevated(resource: URI, value: VSBuffer, options?: IFileWriteOptions, signal?: AbortSignal): Promise<IFileWriteResult> {
		if (!this.isSupported(resource)) { throw new FileOperationNotSupportedError(resource, 'writeFileElevated'); }
		return this.files.writeFileBytes(resource, value.buffer, { create: true, overwrite: true, ...options, writeElevated: true }, signal);
	}
}
