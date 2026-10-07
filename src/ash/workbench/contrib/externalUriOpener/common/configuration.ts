import { localize } from '../../../../nls.js';
import { ConfigurationScope, type IConfigurationKeyDefinition } from '../../../../platform/configuration/common/configurationRegistry.js';
import { defaultExternalUriOpenerId } from '../../../../platform/opener/common/opener.js';
import { testUrlMatchesGlob } from '../../../../platform/url/common/urlGlob.js';

export const externalUriOpenersSettingId = 'workbench.externalUriOpeners';

export interface ExternalUriOpenersConfiguration {
	readonly [uriGlob: string]: string;
}

let contributedIds: readonly string[] = [];
let contributedLabels: readonly string[] = [];

/** Updates completion metadata without changing which IDs are valid in saved rules. */
export function updateContributedOpeners(enumValues: string[], enumDescriptions: string[]): void {
	contributedIds = [...enumValues];
	contributedLabels = [...enumDescriptions];
}

/** Unknown opener IDs stay valid while the owning provider is not registered. */
export const externalUriOpenersConfigurationNode: IConfigurationKeyDefinition<ExternalUriOpenersConfiguration> = {
	key: externalUriOpenersSettingId,
	defaultValue: {},
	scope: ConfigurationScope.WINDOW,
	setting: {
		valueType: 'stringMap',
		get title() { return localize('externalUriOpener.settings.title', 'URL opening rules'); },
		get description() { return localize('externalUriOpener.settings.description', 'Choose how websites open. For example, localhost:* matches local websites and * matches all websites. Rules apply in order. Select an opener with the arrow keys and Enter, or enter its ID.'); },
		keywords: ['URL', 'HTTP', 'HTTPS', 'browser', 'links', 'workbench.externalUriOpeners'],
		get keyLabel() { return localize('externalUriOpener.settings.pattern', 'URL pattern'); },
		get valueLabel() { return localize('externalUriOpener.settings.opener', 'Open with'); },
		get addLabel() { return localize('externalUriOpener.settings.add', 'Add rule'); },
		get removeLabel() { return localize('externalUriOpener.settings.remove', 'Remove rule'); },
		get incompleteMessage() { return localize('externalUriOpener.settings.incomplete', 'Enter both a URL pattern and an opener.'); },
		get duplicateMessage() { return localize('externalUriOpener.settings.duplicate', 'Each URL pattern must be unique.'); },
	},
	parse: value => {
		if (typeof value !== 'object' || value === null || Array.isArray(value) || !Object.entries(value).every(([pattern, id]) => pattern.length > 0 && typeof id === 'string' && id.length > 0)) {
			throw new TypeError(`${externalUriOpenersSettingId} must map URL patterns to opener IDs`);
		}
		for (const pattern of Object.keys(value)) {
			testUrlMatchesGlob('http://ash.invalid/', pattern);
			testUrlMatchesGlob('https://ash.invalid/', pattern);
		}
		return { ...value } as ExternalUriOpenersConfiguration;
	},
	schema: {
		type: 'object',
		get description() { return localize('externalUriOpener.settingDescription', 'Map HTTP and HTTPS URL patterns to opener IDs. Use default for the standard browser. The first matching available opener is used.'); },
		get additionalProperties() {
			return {
				type: 'string' as const, minLength: 1,
				anyOf: [{ type: 'string' as const }, {
					enum: [defaultExternalUriOpenerId, 'ash.browser.open', ...contributedIds],
					enumDescriptions: [localize('externalUriOpener.default', 'Open in default browser'), localize('browser.urlOpener', 'Open in Ash browser'), ...contributedLabels],
				}],
			};
		},
	},
};
