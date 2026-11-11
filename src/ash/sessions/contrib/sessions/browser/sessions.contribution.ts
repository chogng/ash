import { ISessionGitActionsService, SessionGitActionsService } from '../../../services/sessions/browser/sessionGitActionsService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { AutomationsCustomViewContribution } from './views/automationsView.js';
import { SessionsTitleBarWidget } from './sessionsTitleBarWidget.js';
import { BlockedSessionsIndicatorModel, IBlockedSessionsIndicatorService } from './blockedSessionsIndicatorModel.js';
import './sessionsActions.js';
import './views/sessionsViewActions.js';
import './sessionDetailsAction.js';
import { MOUSE_BACK_FORWARD_NAVIGATION_SETTING, SessionsMouseNavigationContribution } from './sessionsMouseNavigation.js';
import { AutomationSessionsListingContribution } from './automationSessionsListing.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { localize } from '../../../../nls.js';

registerSingleton(IBlockedSessionsIndicatorService, BlockedSessionsIndicatorModel, InstantiationType.Delayed);

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: MOUSE_BACK_FORWARD_NAVIGATION_SETTING,
	defaultValue: true,
	parse: value => {
		if (typeof value !== 'boolean') throw new TypeError(localize({ bundle: 'ash.sessions', key: 'sessions.mouseNavigation.invalid' }, 'Mouse navigation must be enabled or disabled.'));
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize({ bundle: 'ash.sessions', key: 'sessions.mouseNavigation.title' }, 'Mouse back and forward'),
		description: localize({ bundle: 'ash.sessions', key: 'sessions.mouseNavigation.description' }, 'Use the mouse Back and Forward buttons to navigate between sessions.'),
	},
});

registerWorkbenchContribution(AutomationsCustomViewContribution.ID, WorkbenchPhase.BlockRestore,
	accessor => accessor.get(IInstantiationService).createInstance(AutomationsCustomViewContribution));

registerWorkbenchContribution(SessionsTitleBarWidget.ID, WorkbenchPhase.BlockRestore,
	accessor => accessor.get(IInstantiationService).createInstance(SessionsTitleBarWidget));

registerWorkbenchContribution(SessionsMouseNavigationContribution.ID, WorkbenchPhase.AfterRestored,
	accessor => accessor.get(IInstantiationService).createInstance(SessionsMouseNavigationContribution));

registerWorkbenchContribution(AutomationSessionsListingContribution.ID, WorkbenchPhase.BlockRestore,
	accessor => accessor.get(IInstantiationService).createInstance(AutomationSessionsListingContribution));

registerSingleton(ISessionGitActionsService, SessionGitActionsService, InstantiationType.Delayed);
