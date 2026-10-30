import type { IObservable } from '../../../../base/common/observable.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export interface IManagedSettingsUpdateInfo {
	readonly title: string;
	readonly message: string;
	readonly detail: string | undefined;
	readonly action: { readonly label: string; readonly href: string; } | undefined;
	readonly updateStatus: string | undefined;
}

export const IManagedSettingsUpdateService = createDecorator<IManagedSettingsUpdateService>('managedSettingsUpdateService');

/** Read-only presentation of backend compatibility failures; does not evaluate execution policy. */
export interface IManagedSettingsUpdateService {
	readonly _serviceBrand: undefined;
	readonly updateInfo: IObservable<IManagedSettingsUpdateInfo | undefined>;
}
