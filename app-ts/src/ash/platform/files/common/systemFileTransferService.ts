import type { URI } from '../../../base/common/uri.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

/** Pastes system file-manager entries into a granted workspace directory. */
export interface ISystemFileTransferService {
	pasteSystemFiles(directory: URI, moveRequested: boolean): Promise<boolean>;
}

export const ISystemFileTransferService = createServiceIdentifier<ISystemFileTransferService>('systemFileTransferService');
