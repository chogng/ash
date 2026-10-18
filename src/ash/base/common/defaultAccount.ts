import type { ManagedSettingsData } from './policy.js';

/** Provider-delivered managed values. The configuration registry declares their UI meanings. */
export interface IPolicyData {
	readonly managedSettings?: ManagedSettingsData;
}
