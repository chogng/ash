import { readBrowserPartsSplash, showPartsSplash } from '../../../workbench/contrib/splash/browser/splash.js';
import { AshWorkbenchName } from '../../common/application.js';
import { showStartupError } from '../../../workbench/browser/startupError.js';
import { IndexedDBFileSystemProvider } from '../../../platform/files/browser/indexedDBFileSystemProvider.js';
import { FileService } from '../../../platform/files/common/fileService.js';
import { URI } from '../../../base/common/uri.js';
import { Schemas } from '../../../base/common/network.js';
import { migrateLegacyBrowserSettings } from '../../../workbench/services/userData/browser/userDataInit.js';
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
	showPartsSplash(document, readBrowserPartsSplash(window));
	{
		using provider = await IndexedDBFileSystemProvider.create(window.indexedDB, Schemas.vscodeUserData);
		await migrateLegacyBrowserSettings(
			window.indexedDB,
			provider,
			URI.from({ scheme: Schemas.vscodeUserData, path: '/user/settings.json' }),
		);
		using files = new FileService();
		using registration = files.registerProvider(Schemas.vscodeUserData, provider);
		await initializeBrowserLocalization(files, new BrowserLanguagePackStore());
	}
	await import('../../../workbench/workbench.web.main.js');
	await import('../../../sessions/common/configuration.js');
	await import('../../../sessions/common/theme.js');
	await import('../../../sessions/contrib/providers/agentHost/browser/workbenchSessionsService.contribution.js');
	await import('../../../sessions/browser/workbenchChat.contribution.js');
	await import('../../../sessions/browser/turnMultiDiffSource.contribution.js');
	await import('../../../sessions/contrib/changes/browser/changesMultiDiffSourceResolver.js');
	registerAction2(
		class OpenCodeSessionsAction extends Action2 {
			constructor() {
				super({
					id: codeSessionsProfile.titlebarActionId,
					title: localize2(
						{ bundle: 'ash.workbench', key: 'command.OpenCodeSessionsAction' },
						'Open Code Sessions',
					),
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
		},
	);
	const { startBrowserWorkbench } = await import('../../../workbench/browser/web.bootstrap.js');
	await startBrowserWorkbench({ productName: AshWorkbenchName }, [createAppServerDebugAdapterCapability]);
} catch (error) {
	showStartupError(error, text => navigator.clipboard.writeText(text));
}
