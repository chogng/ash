import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { IFileService } from './files.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

/** File operations owned by one exact URI scheme. */
export interface IFileSystemProvider extends IFileService {}

/** Installs window-scoped virtual resource providers without changing workspace storage. */
export interface IFileSystemProviderService {
	registerProvider(scheme: string, provider: IFileSystemProvider): IDisposable;
}

export const IFileSystemProviderService = createServiceIdentifier<IFileSystemProviderService>('fileSystemProviderService');
