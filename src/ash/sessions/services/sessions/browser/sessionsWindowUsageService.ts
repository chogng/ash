import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

const windowOpenCountKey = 'sessions.diagnostics.windowOpenCount';

/** Counts starts on this installation for the local Sessions log. */
export class SessionsWindowUsageService {
	readonly windowOpenCount: number;

	constructor(@IStorageService storage: IStorageService) {
		const previous = storage.getNumber(windowOpenCountKey, StorageScope.APPLICATION, 0);
		this.windowOpenCount = Number.isSafeInteger(previous) && previous >= 0 && previous < Number.MAX_SAFE_INTEGER ? previous + 1 : 1;
		storage.store(windowOpenCountKey, this.windowOpenCount, StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	get hadPriorWindowOpen(): boolean { return this.windowOpenCount > 1; }
}
