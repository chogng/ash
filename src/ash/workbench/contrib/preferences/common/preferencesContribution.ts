import { Registry } from '../../../../platform/registry/common/platform.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ConfigurationSchemaId, createConfigurationSchema } from '../../../../platform/configuration/common/configurationSchema.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Extensions as JSONExtensions, type IJSONContributionRegistry } from '../../../../platform/jsonschemas/common/jsonContributionRegistry.js';
import { UserSettingsResource } from '../../../services/preferences/common/settingsEditorInput.js';
import { IFileTextModelService } from '../../../services/textmodelResolver/common/textModelResourceService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IUserDataProfileService } from '../../../services/userDataProfile/common/userDataProfile.js';
import { ConfigurationModelParser } from '../../../../platform/configuration/common/configurationModels.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';

const jsonRegistry = Registry.as<IJSONContributionRegistry>(JSONExtensions.JSONContribution);

/** Owns Preferences resources that must exist before an editor resolves them. */
export class PreferencesContribution extends Disposable {
	public static readonly ID = 'workbench.contrib.preferences';

	public static create(accessor: ServicesAccessor): PreferencesContribution {
		return accessor.get(IInstantiationService).createInstance(PreferencesContribution);
	}

	constructor(
		@IFileTextModelService models: IFileTextModelService,
		@IUserDataProfileService profiles: IUserDataProfileService,
		@ILogService log: ILogService,
	) {
		super();
		jsonRegistry.registerSchema(ConfigurationSchemaId, createConfigurationSchema(), this._store);
		this._register(jsonRegistry.registerSchemaAssociation(ConfigurationSchemaId, UserSettingsResource.toString()));
		const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
		this._register(models.addSaveParticipant({
			participate: async model => {
				if (model.uri.toString() !== profiles.currentProfile.settingsResource.toString()) return;
				const parser = new ConfigurationModelParser(model.uri.toString(), log);
				parser.parse(model.getValue());
				if (parser.errors.length) throw new Error(localize({ bundle: 'ash.settings', key: 'json.invalidDocument' }, 'Fix the JSON errors in settings.json before editing a setting.'));
				const configuration = parser.configurationModel;
				for (const key of configuration.keys) {
					const language = key.startsWith('[');
					const values = language ? configuration.contents[key] as Record<string, unknown> : { [key]: configuration.getValue(key) };
					for (const [key, value] of Object.entries(values)) {
						const setting = registry.getConfiguration(key);
						if (language && setting?.scope !== undefined && setting.scope !== ConfigurationScope.LANGUAGE_OVERRIDABLE) {
							throw new Error(localize('configuration.languageScopeError', 'Setting {0} does not support language overrides', key));
						}
						if (setting) {
							try {
								setting.serialize(setting.parse(value));
							} catch (error) {
								throw new TypeError(localize('configuration.contributedValue', "Setting '{0}' does not match its declared schema.", key), { cause: error });
							}
						}
					}
				}
			},
		}));
	}
}
