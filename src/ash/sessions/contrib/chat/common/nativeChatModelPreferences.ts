import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { localize } from '../../../../nls.js';
import { Extensions as WorkbenchExtensions, type IConfigurationMigrationRegistry } from '../../../../workbench/common/configuration.js';

export const NativeChatModelPreferences = Object.freeze({
	defaultModelSetting: Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<string>({
		key: 'sessions.chat.defaultModel',
		defaultValue: '',
		parse(value: unknown): string {
			if (typeof value !== 'string') { throw new TypeError(localize('sessions.chat.defaultModel.invalid', 'Default Chat model must be a string.')); }
			return value.trim();
		},
		setting: {
			get title() { return localize('sessions.chat.defaultModel.title', 'Default Chat model'); },
			get description() { return localize('sessions.chat.defaultModel.description', 'The model for new Ash Chat conversations. Enter auto or a provider/model ID.'); },
			valueType: 'text',
			get placeholder() { return localize('sessions.chat.defaultModel.placeholder', 'auto or provider/model'); },
		},
	}),
	selectedModelStorageKey: 'sessions.chat.currentLanguageModel',
});

Registry.as<IConfigurationMigrationRegistry>(WorkbenchExtensions.ConfigurationMigration).registerConfigurationMigrations([{
	key: 'cowork.defaultmodel',
	migrateFn(value, read) {
		if (read(NativeChatModelPreferences.defaultModelSetting) !== undefined) return { value: undefined };
		if (typeof value !== 'string') return { value };
		return [
			[NativeChatModelPreferences.defaultModelSetting, { value: value.trim() }],
			['cowork.defaultmodel', { value: undefined }],
		];
	},
}]);
