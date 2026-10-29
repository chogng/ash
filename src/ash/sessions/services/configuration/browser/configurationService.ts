import type { IRegisteredConfiguration } from '../../../../platform/configuration/common/configurationRegistry.js';
import {
	WorkspaceService,
	type WorkspaceServiceOptions,
} from '../../../../workbench/services/configuration/browser/configurationService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IUserDataProfileService } from '../../../../workbench/services/userDataProfile/common/userDataProfile.js';

/** Resolves Agents Window defaults without changing the shared settings resource. */
export class ConfigurationService extends WorkspaceService {
	constructor(
		options: Omit<WorkspaceServiceOptions, 'defaults' | 'readOnlyKeys'> = {},
		@IFileService files: IFileService,
		@ILogService log: ILogService,
		@IUserDataProfileService profile: IUserDataProfileService,
	) {
		super(options, files, log, profile);
	}

	protected override defaultValue(configuration: IRegisteredConfiguration): unknown {
		return configuration.agentsWindow ? configuration.agentsWindow.default : super.defaultValue(configuration);
	}

	protected override isReadOnly(key: string): boolean {
		// Resolve current registrations so extension reloads cannot leave stale window rules.
		return this.registry.getConfiguration(key)?.agentsWindow?.readOnly === true;
	}
}
