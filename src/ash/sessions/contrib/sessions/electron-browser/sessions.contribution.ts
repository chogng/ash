import { isRecord } from '../../../../base/common/types.js';
import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { invoke } from '../../../../platform/ipc/electron-browser/rendererIpc.js';
import { APPLICATION_BADGE_CHANNEL, type IApplicationBadge } from '../../../../platform/native/common/native.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { SESSIONS_APPLICATION_BADGE_DEFAULT, SESSIONS_APPLICATION_BADGE_OPTIONS_DEFAULT, SESSIONS_APPLICATION_BADGE_OPTIONS_SETTING, SESSIONS_APPLICATION_BADGE_SETTING, SessionsApplicationBadge } from './sessionsApplicationBadge.js';

const registry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
registry.registerConfiguration({
	key: SESSIONS_APPLICATION_BADGE_SETTING,
	scope: ConfigurationScope.APPLICATION,
	defaultValue: SESSIONS_APPLICATION_BADGE_DEFAULT,
	parse: value => {
		if (typeof value !== 'boolean') throw new TypeError(localize({ bundle: 'ash.sessions', key: 'sessions.applicationBadge.invalidEnabled' }, 'The application badge setting must be a boolean.'));
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize({ bundle: 'ash.sessions', key: 'sessions.applicationBadge.title' }, 'Show Sessions application badge'),
		description: localize({ bundle: 'ash.sessions', key: 'sessions.applicationBadge.description' }, 'Show how many sessions need attention on the application icon.'),
	},
});

registry.registerConfiguration({
	key: SESSIONS_APPLICATION_BADGE_OPTIONS_SETTING,
	scope: ConfigurationScope.APPLICATION,
	defaultValue: SESSIONS_APPLICATION_BADGE_OPTIONS_DEFAULT,
	schema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			inputNeeded: { type: 'boolean', default: true, description: localize({ bundle: 'ash.sessions', key: 'sessions.applicationBadge.inputNeeded' }, 'Count sessions waiting for input or approval.') },
			ciFailing: { type: 'boolean', default: false, description: localize({ bundle: 'ash.sessions', key: 'sessions.applicationBadge.ciFailing' }, 'Count inactive conversations with failing checks on an open pull request.') },
		},
	},
	parse: value => {
		if (!isRecord(value) || Object.keys(value).some(key => key !== 'inputNeeded' && key !== 'ciFailing')
			|| (value.inputNeeded !== undefined && typeof value.inputNeeded !== 'boolean')
			|| (value.ciFailing !== undefined && typeof value.ciFailing !== 'boolean')) {
			throw new TypeError(localize({ bundle: 'ash.sessions', key: 'sessions.applicationBadge.invalidOptions' }, 'Application badge options must be boolean values for inputNeeded and ciFailing.'));
		}
		return { inputNeeded: value.inputNeeded ?? SESSIONS_APPLICATION_BADGE_OPTIONS_DEFAULT.inputNeeded, ciFailing: value.ciFailing ?? SESSIONS_APPLICATION_BADGE_OPTIONS_DEFAULT.ciFailing };
	},
});

registerWorkbenchContribution(SessionsApplicationBadge.ID, WorkbenchPhase.AfterRestored, accessor =>
	accessor.get(IInstantiationService).createInstance(SessionsApplicationBadge, (badge: IApplicationBadge) => invoke<void>(APPLICATION_BADGE_CHANNEL, badge)));
