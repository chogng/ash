import type { Event } from '../../../../base/common/event.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IOpenEmptyWindowOptions } from '../../../../platform/window/common/window.js';

/** Opens an empty Workbench through the window host and its unload lifecycle. */
export interface IHostService {
	readonly hasFocus: boolean;
	readonly onDidChangeFocus: Event<boolean>;
	openWindow(options?: IOpenEmptyWindowOptions): Promise<void>;
	restart(): Promise<void>;
	/** Captures a PNG; browser hosts ask the user to choose a display surface. */
	getScreenshot(): Promise<Uint8Array | undefined>;
}

export const IHostService = createServiceIdentifier<IHostService>('hostService');
