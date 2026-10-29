import { createDecorator } from '../../instantiation/common/instantiation.js';
import { Event } from '../../../base/common/event.js';
import { Registry } from '../../registry/common/platform.js';
import {
	ConfigurationScope,
	Extensions,
	type IConfigurationRegistry,
} from '../../configuration/common/configurationRegistry.js';
import { localize } from '../../../nls.js';

export const IBrowserPasswordService = createDecorator<IBrowserPasswordService>('browserPasswordService');
export interface BrowserSavedPassword {
	readonly id: string;
	readonly origin: string;
	readonly username: string;
	readonly scope: 'global' | 'workspace';
}
export interface BrowserPasswordState {
	readonly available: boolean;
	readonly entries: readonly BrowserSavedPassword[];
	readonly corrupted: number;
}
/** The settings client gets metadata and mutations, never saved password values. */
export interface IBrowserPasswordService {
	readonly onDidChange: Event<void>;
	readState(): Promise<BrowserPasswordState>;
	update(id: string, username: string, password: string): Promise<void>;
	delete(id: string): Promise<void>;
	clear(): Promise<void>;
}

/** Web hosts explicitly lack the Desktop password vault. Bootstrap supplies this capability. */
export const UnavailableBrowserPasswordService: IBrowserPasswordService = {
	onDidChange: Event.None,
	readState: async () => ({ available: false, entries: [], corrupted: 0 }),
	update: async () => {
		throw new Error('Browser password storage unavailable');
	},
	delete: async () => {
		throw new Error('Browser password storage unavailable');
	},
	clear: async () => {
		throw new Error('Browser password storage unavailable');
	},
};

for (const [key, title, description] of [
	[
		'workbench.browser.savePasswords',
		localize('browser.passwords.saveSetting', 'Offer to save website passwords'),
		localize(
			'browser.passwords.saveDescription',
			'Offer to save or update passwords after a login form is submitted and disappears. Passwords require system encryption and a persistent user browser session.',
		),
	],
	[
		'workbench.browser.autofillPasswords',
		localize('browser.passwords.fillSetting', 'Automatically fill website passwords'),
		localize(
			'browser.passwords.fillDescription',
			'Fill saved accounts when you interact with a visible login form or SPA panel on the exact saved origin, including username-first steps. New-password fields, cross-origin frames and Agent pages are excluded.',
		),
	],
] as const) {
	Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
		key,
		defaultValue: true,
		scope: ConfigurationScope.APPLICATION,
		parse: value => {
			if (typeof value !== 'boolean') {
				throw new TypeError('Invalid browser password preference');
			}
			return value;
		},
		setting: { valueType: 'boolean', title, description },
	});
}
