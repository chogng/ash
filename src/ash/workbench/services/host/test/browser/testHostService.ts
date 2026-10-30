import type { IWorkbenchWindowInfo } from '../../../../../platform/window/common/window.js';
import { Event } from '../../../../../base/common/event.js';
import type { VSBuffer } from '../../../../../base/common/buffer.js';
import type { IOpenEmptyWindowOptions, IOpenWindowOptions, IWindowOpenable } from '../../../../../platform/window/common/window.js';
import type { IHostService } from '../../browser/host.js';

/** Records host requests without opening windows in service tests. */
export class TestHostService implements IHostService {
	windows: readonly IWorkbenchWindowInfo[] = [{ id: 1, title: 'Editor', focused: true, current: true, kind: 'editor' }];
	async getWindows(options: { readonly includeAuxiliaryWindows: boolean; }): Promise<readonly IWorkbenchWindowInfo[]> {
		return this.windows.filter(window => options.includeAuxiliaryWindows || window.kind !== 'auxiliary');
	}
	readonly hasFocus = true;
	readonly onDidChangeFocus = Event.None;
	readonly opened: { readonly targets: readonly IWindowOpenable[]; readonly options: IOpenWindowOptions; }[] = [];

	openWindow(options?: IOpenEmptyWindowOptions): Promise<void>;
	openWindow(toOpen: readonly IWindowOpenable[], options?: IOpenWindowOptions): Promise<void>;
	async openWindow(targetsOrOptions: readonly IWindowOpenable[] | IOpenEmptyWindowOptions = {}, options: IOpenWindowOptions = {}): Promise<void> {
		this.opened.push(Array.isArray(targetsOrOptions) ? { targets: targetsOrOptions, options } : { targets: [], options: targetsOrOptions as IOpenEmptyWindowOptions });
	}
	async restart(): Promise<void> { throw new Error('Unexpected host restart'); }
	async reload(): Promise<void> { throw new Error('Unexpected host reload'); }
	async getScreenshot(): Promise<VSBuffer | undefined> { return undefined; }
}
