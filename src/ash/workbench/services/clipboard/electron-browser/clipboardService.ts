import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ElectronRendererClipboardService } from '../../../../platform/clipboard/electron-browser/electronRendererClipboardService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';

// The platform adapter also serves account authentication outside the Workbench.
registerSingleton(IClipboardService, ElectronRendererClipboardService, InstantiationType.Delayed);
