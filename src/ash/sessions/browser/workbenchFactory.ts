import { IWorkbenchEnvironmentService } from '../../workbench/services/environment/common/environmentService.js';
import {
	IDefaultLogLevelsService,
	DefaultLogLevelsService,
	readDefaultLogLevels,
} from '../../workbench/services/log/common/defaultLogLevels.js';
import { InstantiationService } from '../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { SyncDescriptor } from '../../platform/instantiation/common/descriptors.js';
import '../../workbench/services/configuration/common/jsonEditingService.js';
import { FileService } from '../../platform/files/common/fileService.js';
import { UserSettings } from '../../platform/configuration/common/configurationModels.js';
import { URI } from '../../base/common/uri.js';
import { extUriBiasedIgnorePathCase } from '../../base/common/resources.js';
import { Schemas } from '../../base/common/network.js';
import { ExtensionColorThemeService } from '../../workbench/services/extensions/browser/extensionColorThemeService.js';
import type { IStorageService } from '../../platform/storage/common/storage.js';
import type { IDisposable } from '../../base/common/lifecycle.js';
import type { IFileSystemProvider } from '../../platform/files/common/files.js';
import type { Workbench, IWorkbenchOptions } from './workbench.js';
import { DesktopWorkbench } from './desktopWorkbench.js';

/** Prepares the window resources before constructing its supported desktop presentation. */
export async function createSessionsWorkbench(options: IWorkbenchOptions): Promise<Workbench> {
	const themes = new ExtensionColorThemeService(options.api.extensions, options.api.events);
	const logger = options.createLogService();
	let storage: (IStorageService & IDisposable) | undefined;
	let userDataFiles: (IFileSystemProvider & IDisposable) | undefined;
	try {
		await themes.start();
		const ownerWindow = options.container.ownerDocument.defaultView;
		if (!ownerWindow) {
			throw new Error('Sessions renderer requires an owner window');
		}
		storage = await options.createStorageService({
			ownerWindow,
			workspaceId: 'sessions',
			profileId: options.profile.id,
		});
		userDataFiles = await options.createUserDataFileSystemProvider();
		{
			using startupFiles = new FileService();
			using registration = startupFiles.registerProvider(Schemas.vscodeUserData, userDataFiles);
			const collection = options.serviceCollection ?? new ServiceCollection();
			using startupServices = new InstantiationService(new ServiceCollection(...collection.entries()));
			const environment = startupServices.get(IWorkbenchEnvironmentService);
			collection.set(IWorkbenchEnvironmentService, environment);
			const levels = await readDefaultLogLevels(startupFiles, environment, logger);
			logger.setLevel(levels.default);
			collection.set(IDefaultLogLevelsService, new SyncDescriptor(DefaultLogLevelsService, [levels]));
			options = { ...options, serviceCollection: collection };
		}
		if (!options.initialConfiguration) {
			using files = new FileService();
			using registration = files.registerProvider(Schemas.vscodeUserData, userDataFiles);
			using settings = new UserSettings(
				URI.from({ scheme: Schemas.vscodeUserData, path: '/user/settings.json' }),
				{},
				extUriBiasedIgnorePathCase,
				files,
				logger,
			);
			options = { ...options, initialConfiguration: (await settings.loadConfiguration()).toJSON() };
		}
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
