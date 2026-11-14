import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IWorkingCopy } from '../../../../workbench/services/workingCopy/common/workingCopyService.js';

/** Product save policy; registered working copies retain ownership of content and persistence. */
export interface IArtifactAutoSaveService {
	register(copy: IWorkingCopy): IDisposable;
	/** Drain the latest edits before closing a retained artifact editor. */
	flush(resource: URI): Promise<void>;
}

export const IArtifactAutoSaveService = createServiceIdentifier<IArtifactAutoSaveService>('artifactAutoSaveService');
