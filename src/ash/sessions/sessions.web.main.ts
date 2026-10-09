import { InstantiationType, registerSingleton } from '../platform/instantiation/common/extensions.js';
import { BrowserElevatedFileService } from '../workbench/services/files/browser/elevatedFileService.js';
import { IElevatedFileService } from '../workbench/services/files/common/elevatedFileService.js';
import './sessions.common.main.js';
import './browser/parts/menubar.contribution.js';
import './browser/web.main.js';

registerSingleton(IElevatedFileService, BrowserElevatedFileService, InstantiationType.Delayed);
