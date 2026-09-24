import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationResourceService } from '../../../../platform/configuration/common/configurationResourceService.js';
import { ConfigurationSchemaId, createConfigurationSchema } from '../../../../platform/configuration/common/configurationSchema.js';
import { IFileSystemProviderService } from '../../../../platform/files/common/fileSystemProviderService.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { JsonSchemasRegistry } from '../../../../platform/jsonschemas/common/jsonSchemaRegistry.js';
import { UserSettingsResource } from '../../../services/preferences/common/preferencesEditorInput.js';
import { SettingsFileSystemProvider } from './settingsFilesystemProvider.js';

/** Owns Preferences resources that must exist before an editor resolves them. */
export class PreferencesContribution extends Disposable {
	public static readonly ID = 'workbench.contrib.preferences';

	public static create(accessor: ServicesAccessor): PreferencesContribution {
		return new PreferencesContribution(
			accessor.get(IFileSystemProviderService),
			accessor.get(IConfigurationResourceService),
		);
	}

	constructor(
		fileSystemProviders: IFileSystemProviderService,
		configurationResourceService: IConfigurationResourceService,
	) {
		super();
		const provider = this._register(new SettingsFileSystemProvider(configurationResourceService));
		this._register(fileSystemProviders.registerProvider(SettingsFileSystemProvider.scheme, provider));
		this._register(JsonSchemasRegistry.registerSchema(ConfigurationSchemaId, createConfigurationSchema()));
		this._register(JsonSchemasRegistry.registerAssociation(UserSettingsResource, ConfigurationSchemaId));
	}
}
