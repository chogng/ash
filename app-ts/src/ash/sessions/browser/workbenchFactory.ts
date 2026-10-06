import { ExtensionColorThemeService } from '../../workbench/services/extensions/browser/extensionColorThemeService.js';
import type { IStorageService } from '../../platform/storage/common/storage.js';
import type { IDisposable } from '../../base/common/lifecycle.js';
import type { IFileSystemProvider } from '../../platform/files/common/fileSystemProviderService.js';
import type { Workbench, IWorkbenchOptions } from './workbench.js';
import { DesktopWorkbench } from './desktopWorkbench.js';

/** Prepares the window resources before constructing its supported desktop presentation. */
export async function createSessionsWorkbench(options: IWorkbenchOptions): Promise<Workbench> {
	const themes = new ExtensionColorThemeService(options.api.extensions, options.api.events);
	const logger = options.createLogService();
	let storage: IStorageService & IDisposable | undefined;
	let userDataFiles: IFileSystemProvider & IDisposable | undefined;
	try {
		await themes.start();
		const ownerWindow = options.container.ownerDocument.defaultView;
		if (!ownerWindow) { throw new Error('Sessions renderer requires an owner window'); }
		storage = await options.createStorageService({ ownerWindow, workspaceId: 'sessions', profileId: options.profile.id });
		userDataFiles = await options.createUserDataFileSystemProvider();
		return new DesktopWorkbench(options, themes, storage, logger, userDataFiles);
	} catch (error) {
		userDataFiles?.dispose();
		logger.error('startup', 'Agents startup failed', error);
		logger.dispose();
		storage?.dispose();
		themes.dispose();
		throw error;
	}
}

