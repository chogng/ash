import { AshWorkbenchName } from '../../common/application.js';
import { showStartupError } from '../../../workbench/browser/startupError.js';
import { IndexedDbConfigurationApi } from '../../../platform/configuration/browser/indexedDbConfigurationApi.js';
import { BrowserLanguagePackStore } from '../../../platform/languagePacks/browser/languagePackStore.js';
import { initializeBrowserLocalization } from '../../../workbench/services/localization/browser/localizationBootstrap.js';
import { localize2 } from '../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../platform/actions/common/actions.js';
import { ILayoutService } from '../../../platform/layout/browser/layoutService.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { ashTitlebarMark } from '../../../workbench/browser/parts/titlebar/titlebarMark.js';
import { codeSessionsProfile } from '../../common/codeSessionsProfile.js';
import { createAppServerDebugAdapterCapability } from '../../../platform/debug/browser/appServerDebugAdapterProcessService.js';

try {
	{
		using configuration = new IndexedDbConfigurationApi();
		await initializeBrowserLocalization(configuration, new BrowserLanguagePackStore());
	}
	await import('../../../workbench/workbench.web.main.js');
	await import('../../../sessions/common/configuration.js');
	await import('../../../sessions/common/theme.js');
	await import('../../../sessions/contrib/providers/agentHost/browser/workbenchSessionsService.contribution.js');
	await import('../../../sessions/browser/workbenchChat.contribution.js');
	await import('../../../sessions/browser/turnMultiDiffSource.contribution.js');
	registerAction2(class OpenCodeSessionsAction extends Action2 {
		constructor() {
			super({
				id: codeSessionsProfile.titlebarActionId,
				title: localize2({ bundle: 'ash.workbench', key: 'command.OpenCodeSessionsAction' }, 'Open Code Sessions'),
				tooltip: 'Open Code Sessions',
				icon: ashTitlebarMark,
				menu: { id: MenuId.TitleBarAdjacentCenter, group: 'navigation', order: 1 },
				f1: true,
			});
		}

		public override run(accessor: ServicesAccessor): void {
			const location = accessor.get(ILayoutService).activeContainer.ownerDocument.location;
			location.assign(new URL('../sessions/sessions.html', location.href).href);
		}
	});
	const { startBrowserWorkbench } = await import('../../../workbench/browser/web.bootstrap.js');
	await startBrowserWorkbench({ productName: AshWorkbenchName }, [createAppServerDebugAdapterCapability]);
} catch (error) {
	showStartupError(error, text => navigator.clipboard.writeText(text));
}
