import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export type DesktopUpdatePolicy = 'latest' | 'stable' | 'never';
export const DESKTOP_UPDATE_POLICY_SETTING = 'update.policy';

export type UpdateCheckResult =
	| { readonly status: 'current'; readonly version: string }
	| { readonly status: 'available'; readonly currentVersion: string; readonly version: string };

export interface UpdateReadyResult {
	readonly version: string;
}

/** Controls one installed desktop product update without exposing package paths to the renderer. */
export interface IUpdateService {
	checkForUpdates(): Promise<UpdateCheckResult>;
	checkAutomatically(): Promise<UpdateCheckResult | undefined>;
	downloadUpdate(): Promise<UpdateReadyResult>;
	installUpdate(): Promise<void>;
}

export const IUpdateService = createServiceIdentifier<IUpdateService>('updateService');
export const UPDATE_CHECK_CHANNEL = 'ash:update:check';
export const UPDATE_AUTO_CHECK_CHANNEL = 'ash:update:auto-check';
export const UPDATE_DOWNLOAD_CHANNEL = 'ash:update:download';
export const UPDATE_INSTALL_CHANNEL = 'ash:update:install';

export function validateUpdateRequest(value: unknown): 'latest' | 'stable' {
	if (value !== 'latest' && value !== 'stable') throw new TypeError('Desktop update channel is invalid');
	return value;
}

export function validateInstallRequest(value: unknown): void {
	if (value !== undefined) throw new TypeError('Desktop installation takes no renderer arguments');
}
