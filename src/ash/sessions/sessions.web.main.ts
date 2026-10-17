import '../workbench/contrib/terminal/browser/terminal.web.contribution.js';
import '../workbench/contrib/splash/browser/splash.contribution.js';
import '../workbench/contrib/update/browser/update.contribution.js';
import { InstantiationType, registerSingleton } from '../platform/instantiation/common/extensions.js';
import { IUpdateService } from '../platform/update/common/updateService.js';
import { BrowserUpdateService } from '../workbench/services/update/browser/updateService.js';
import { BrowserElevatedFileService } from '../workbench/services/files/browser/elevatedFileService.js';
import { IElevatedFileService } from '../workbench/services/files/common/elevatedFileService.js';
import { IRemoteAuthorityResolverService } from '../platform/remote/common/remoteAuthorityResolver.js';
import { RemoteAuthorityResolverService } from '../platform/remote/browser/remoteAuthorityResolverService.js';
import './sessions.common.main.js';
import './browser/parts/menubar.contribution.js';
import './browser/web.main.js';

registerSingleton(IElevatedFileService, BrowserElevatedFileService, InstantiationType.Delayed);
registerSingleton(IUpdateService, BrowserUpdateService, InstantiationType.Delayed);
registerSingleton(IRemoteAuthorityResolverService, RemoteAuthorityResolverService, InstantiationType.Delayed);
