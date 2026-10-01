import { toDisposable } from "../../../../base/common/lifecycle.js";
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { StartupKind } from '../common/lifecycle.js';
import { AbstractLifecycleService } from '../common/lifecycleService.js';

export interface BrowserLifecycleServiceOptions {
	readonly ownerWindow: Window;
	readonly onError: (error: unknown) => void;
}

/** Binds the browser page lifetime to the shared window lifecycle. */
export class BrowserLifecycleService extends AbstractLifecycleService {
	constructor(options: BrowserLifecycleServiceOptions, @ILogService logService: ILogService, @IStorageService storageService: IStorageService) {
		const navigation = options.ownerWindow.performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
		super(navigation?.type === 'reload' ? StartupKind.ReloadedWindow : undefined, logService, storageService);
		const onPageHide = (): void => { void this.shutdown("pageHide").catch(options.onError); };
		options.ownerWindow.addEventListener("pagehide", onPageHide);
		this._register(toDisposable(() => options.ownerWindow.removeEventListener("pagehide", onPageHide)));
	}
}
