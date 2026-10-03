import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IOpenEmptyWindowOptions } from '../../../../platform/window/common/window.js';

/** Opens an empty Workbench through the window host and its unload lifecycle. */
export interface IHostService {
	openWindow(options?: IOpenEmptyWindowOptions): Promise<void>;
	restart(): Promise<void>;
}

export const IHostService = createServiceIdentifier<IHostService>('hostService');
