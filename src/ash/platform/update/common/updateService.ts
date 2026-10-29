import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { Event } from '../../../base/common/event.js';

export type DesktopUpdatePolicy = 'latest' | 'stable' | 'never';
export const DESKTOP_UPDATE_POLICY_SETTING = 'update.policy';

export type UpdateCheckResult = { readonly status: 'current'; readonly version?: string } | { readonly status: 'available'; readonly currentVersion?: string; readonly version: string };

export interface UpdateReadyResult {
	readonly version: string;
}

export type UpdateState = 'idle' | 'downloading' | 'ready' | 'installing';

/**
 * Desktop updates use signed packages; Web updates reload through the host lifecycle.
 * Web embedders need only report the available build, so the running version is optional.
 */
export interface IUpdateService {
	/** The installed-product updater owns download, verification and restart readiness. */
	readonly state: UpdateState;
	readonly onDidChangeState: Event<UpdateState>;
	checkForUpdates(): Promise<UpdateCheckResult>;
	checkAutomatically(): Promise<UpdateCheckResult | undefined>;
	downloadUpdate(): Promise<UpdateReadyResult>;
	installUpdate(): Promise<void>;
}

export const IUpdateService = createServiceIdentifier<IUpdateService>('updateService');

export function validateUpdateRequest(value: unknown): 'latest' | 'stable' {
	if (value !== 'latest' && value !== 'stable') throw new TypeError('Desktop update channel is invalid');
	return value;
}

export function validateInstallRequest(value: unknown): void {
	if (value !== undefined) throw new TypeError('Desktop installation takes no renderer arguments');
}
