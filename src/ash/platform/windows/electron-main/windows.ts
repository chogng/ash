import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { IWorkspaceOpenTarget } from '../../environment/common/argv.js';
import type { IWindowFileOpen } from '../../window/common/window.js';

export interface IOpenConfiguration {
	readonly workspace?: IWorkspaceOpenTarget;
	readonly cwd: string;
	readonly files: readonly IWindowFileOpen[];
	readonly forceNewWindow: boolean;
	readonly forceReuseWindow: boolean;
	readonly waitForFiles: boolean;
}

export interface IWindowsMainService {
	open(configuration: IOpenConfiguration): Promise<{ readonly whenClosed: Promise<void>; readonly whenFilesClosed: Promise<void>; }>;
}

export const IWindowsMainService = createServiceIdentifier<IWindowsMainService>('windowsMainService');
