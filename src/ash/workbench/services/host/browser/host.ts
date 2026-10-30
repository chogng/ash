import type { IWorkbenchWindowInfo } from '../../../../platform/window/common/window.js';
import type { Event } from '../../../../base/common/event.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IOpenEmptyWindowOptions, IOpenWindowOptions, IWindowOpenable } from '../../../../platform/window/common/window.js';
import type { VSBuffer } from '../../../../base/common/buffer.js';
import type { IRectangle } from '../../../../platform/window/common/window.js';

/** Opens an empty Workbench through the window host and its unload lifecycle. */
export interface IHostService {
	readonly hasFocus: boolean;
	/** Enumerates this host's windows using the native registry roles where available. */
	getWindows(options: { readonly includeAuxiliaryWindows: boolean; }): Promise<readonly IWorkbenchWindowInfo[]>;
	readonly onDidChangeFocus: Event<boolean>;
	openWindow(options?: IOpenEmptyWindowOptions): Promise<void>;
	openWindow(toOpen: readonly IWindowOpenable[], options?: IOpenWindowOptions): Promise<void>;
	restart(): Promise<void>;
	reload(options?: { disableExtensions?: boolean; }): Promise<void>;
	/** Raw PNG capture without workbench editing; browser hosts ask the user to choose a display surface. */
	getScreenshot(rect?: IRectangle): Promise<VSBuffer | undefined>;
}

export const IHostService = createServiceIdentifier<IHostService>('hostService');
