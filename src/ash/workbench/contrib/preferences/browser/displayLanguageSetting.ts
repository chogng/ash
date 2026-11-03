import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { ILanguagePackService } from '../../../../platform/languagePacks/common/languagePacks.js';
import { LocalizationConfiguration, type ILocaleService } from '../../../services/localization/common/locale.js';
import type { ILocalizationService } from '../../../services/localization/common/localizationService.js';
import type { ISelectSetting, ISetting } from '../../../services/preferences/common/preferences.js';

export function displayLanguageSetting(setting: ISetting, locale: ILocaleService, languagePacks: ILanguagePackService, localization: ILocalizationService, configuration: IConfigurationService): ISelectSetting {
	if (setting.valueType !== 'select') throw new TypeError('Display language requires a select setting');
	return {
		...setting,
		get title() { return localization.translate('ash.settings', 'displayLanguage.select', 'Interface language'); },
		get description() { return localization.translate('ash.settings', 'displayLanguage.description', 'Choose the language used by the Ash interface.'); },
		get options() {
			const options = languagePacks.catalogs
				.map(catalog => ({ value: catalog.locale, label: catalog.localizedLanguageName }))
				.sort((left, right) => left.value.localeCompare(right.value));
			const preference = configuration.getValue<string>(LocalizationConfiguration.locale);
			// A selected local resource remains valid after its Extensions package is removed.
			if (!options.some(option => option.value === preference)) options.push({ value: preference, label: preference });
			return options;
		},
		// The setting shows the next startup's preference while this UI keeps its active language.
		binding: {
			id: setting.id,
			defaultValue: setting.configuration.defaultValue,
			onDidChange: listener => configuration.onDidChangeConfiguration(event => { if (event.affectsConfiguration(LocalizationConfiguration.locale)) { listener(); } }),
			getValue: () => configuration.getValue(LocalizationConfiguration.locale),
			isDefault: () => configuration.inspect(LocalizationConfiguration.locale).userLocalValue === undefined,
			updateValue: value => locale.setLocale({ id: String(value), label: String(value) }),
			resetValue: () => locale.clearLocalePreference(),
		},
	};
}
