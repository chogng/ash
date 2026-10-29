import type { VSBuffer } from '../../../../base/common/buffer.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IFileWriteOptions, IFileWriteResult } from '../../../../platform/files/common/files.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

/** Explicit system-authorized saves; the provider retains directory authority and byte revisions.
 * Current providers support create-or-replace only: existing files require a revision, new targets must be absent.
 */
export interface IElevatedFileService {
	isSupported(resource: URI): boolean;
	writeFileElevated(resource: URI, value: VSBuffer, options?: IFileWriteOptions, signal?: AbortSignal): Promise<IFileWriteResult>;
}

export const IElevatedFileService = createServiceIdentifier<IElevatedFileService>('elevatedFileService');
