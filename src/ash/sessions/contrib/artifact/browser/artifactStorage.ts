import { URI } from '../../../../base/common/uri.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

/** The directory is a persisted file location, shared by existing document links and draft pointers. */
export function getArtifactDraftHome(profileLocation: URI, workspaceId: string): URI {
	return URI.joinPath(profileLocation, 'creator', encodeURIComponent(workspaceId));
}

/** Migrate state keys on read; all current writers use the Artifacts namespace. */
export function readArtifactState(storage: IStorageService, key: string): string | undefined {
	const legacy = key.replace(/^sessions\.artifacts\./u, 'sessions.creator.').replace(/^artifacts\./u, 'creator.');
	const current = storage.get(key, StorageScope.WORKSPACE);
	const value = current ?? storage.get(legacy, StorageScope.WORKSPACE);
	if (value !== undefined && current === undefined) storage.store(key, value, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	if (legacy !== key) storage.remove(legacy, StorageScope.WORKSPACE);
	return value;
}
