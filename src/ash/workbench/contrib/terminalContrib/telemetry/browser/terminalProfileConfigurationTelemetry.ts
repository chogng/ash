import { Disposable } from '../../../../../base/common/lifecycle.js';
import { equals } from '../../../../../base/common/objects.js';
import {
	ConfigurationTargetToString,
	IConfigurationService,
	type IConfigurationValue,
} from '../../../../../platform/configuration/common/configuration.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';

/** Reports only configuration presence and change kind; profile contents never cross this boundary. */
export class TerminalProfileConfigurationTelemetry extends Disposable {
	constructor(
		@IConfigurationService configuration: IConfigurationService,
		@ITelemetryService telemetry: ITelemetryService,
	) {
		super();
		for (const profileType of ['default', 'automation']) {
			for (const os of ['linux', 'osx', 'windows']) {
				const settingId = `terminal.integrated.${profileType}Profile.${os}`;
				let previous = configuredValue(configuration.inspect(settingId));
				if (previous !== undefined && previous !== null)
					telemetry.publicLog('terminal/profileSettingState', {
						settingId,
						profileType,
						os,
						configured: true,
					});
				this._register(
					configuration.onDidChangeConfiguration(event => {
						if (!event.affectsConfiguration(settingId)) return;
						const current = configuredValue(configuration.inspect(settingId));
						if (equals(previous, current)) return;
						const configured = current !== undefined && current !== null;
						const hadValue = previous !== undefined && previous !== null;
						previous = current;
						telemetry.publicLog('terminal/profileSettingChanged', {
							settingId,
							profileType,
							os,
							configured,
							changeType: !configured ? 'removed' : hadValue ? 'changed' : 'added',
							source: ConfigurationTargetToString(event.source),
						});
					}),
				);
			}
		}
	}
}

function configuredValue(value: IConfigurationValue<unknown>): unknown {
	return [
		value.memoryValue,
		value.workspaceFolderValue,
		value.workspaceValue,
		value.userRemoteValue,
		value.userLocalValue,
		value.userValue,
		value.applicationValue,
	].find(candidate => candidate !== undefined);
}
