import type { URI } from '../../../base/common/uri.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

/** Moves the current Windows shell cut entry into a granted workspace directory. */
export interface ISystemFileTransferService {
	pasteSystemCutFiles(directory: URI): Promise<boolean>;
}

export const ISystemFileTransferService = createServiceIdentifier<ISystemFileTransferService>('systemFileTransferService');
