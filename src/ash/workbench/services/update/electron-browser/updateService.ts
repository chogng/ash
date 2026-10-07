import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IUpdateService } from '../../../../platform/update/common/updateService.js';
import { ElectronUpdateService } from '../../../../platform/update/electron-browser/updateService.js';

if (isWindows || isMacintosh) {
	registerSingleton(IUpdateService, ElectronUpdateService, InstantiationType.Delayed);
}
