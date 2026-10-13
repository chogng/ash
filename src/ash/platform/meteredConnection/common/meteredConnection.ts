import type { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IMeteredConnectionService = createDecorator<IMeteredConnectionService>('meteredConnectionService');

/** The effective local network policy, including the application setting override. */
export interface IMeteredConnectionService {
	readonly _serviceBrand: undefined;
	readonly isConnectionMetered: boolean;
	readonly whenConnectionStateInitialized?: Promise<void>;
	readonly onDidChangeIsConnectionMetered: Event<boolean>;
}

export const METERED_CONNECTION_SETTING_KEY = 'network.meteredConnection';
export type MeteredConnectionSettingValue = 'on' | 'off' | 'auto';
