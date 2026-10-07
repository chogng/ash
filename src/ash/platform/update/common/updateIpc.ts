import type { Event } from '../../../base/common/event.js';
import type { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { validateInstallRequest, validateUpdateRequest, type UpdateCheckResult, type UpdateReadyResult } from './updateService.js';

interface UpdateHost {
	checkForUpdates(policy: 'latest' | 'stable'): Promise<UpdateCheckResult>;
	checkAutomatically(policy: 'latest' | 'stable'): Promise<UpdateCheckResult | undefined>;
	downloadUpdate(policy: 'latest' | 'stable'): Promise<UpdateReadyResult>;
	installUpdate(): Promise<void>;
}

/** Validates renderer requests before they reach the shared installed-product updater. */
export class UpdateChannel implements IServerChannel {
	constructor(private readonly service: UpdateHost) { }

	public async call<T>(_context: string, command: string, arg?: unknown): Promise<T> {
		switch (command) {
			case 'checkForUpdates': return await this.service.checkForUpdates(validateUpdateRequest(arg)) as T;
			case 'checkAutomatically': return await this.service.checkAutomatically(validateUpdateRequest(arg)) as T;
			case 'downloadUpdate': return await this.service.downloadUpdate(validateUpdateRequest(arg)) as T;
			case 'installUpdate': validateInstallRequest(arg); return await this.service.installUpdate() as T;
			default: throw new Error(`Unknown update command: ${command}`);
		}
	}

	public listen<T>(_context: string, event: string): Event<T> {
		throw new Error(`Unknown update event: ${event}`);
	}
}
