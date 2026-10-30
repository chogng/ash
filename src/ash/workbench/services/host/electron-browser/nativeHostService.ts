import type { IWorkbenchWindowInfo } from '../../../../platform/window/common/window.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IPathService } from '../../../../platform/path/common/pathService.js';
import { INativeHostService } from '../../../common/services.js';
import type { INativeHostApi } from '../../../../platform/native/common/nativeHost.js';
import type { IOpenEmptyWindowOptions, IOpenWindowOptions, IWindowOpenable } from '../../../../platform/window/common/window.js';
import { BrowserHostService } from '../browser/browserHostService.js';
import { ILifecycleService } from '../../lifecycle/common/lifecycle.js';
import { HOST_RESTART_CHANNEL } from '../../../../platform/window/common/window.js';
import { invoke } from '../../../../platform/ipc/electron-browser/rendererIpc.js';
import type { IRectangle } from '../../../../platform/window/common/window.js';
import type { VSBuffer } from '../../../../base/common/buffer.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IsSessionsWindowContext } from '../../../common/contextkeys.js';

export class NativeHostService extends BrowserHostService {
	constructor(
		@INativeHostService private readonly host: INativeHostApi,
		@ILifecycleService lifecycle: ILifecycleService,
		@IContextKeyService private readonly contexts: IContextKeyService,
		@IDialogService dialogs: IDialogService,
		@IPathService paths: IPathService,
		@IFileService files: IFileService,
	) { super({}, lifecycle, dialogs, paths, files); }

	public override async getWindows(options: { readonly includeAuxiliaryWindows: boolean; }): Promise<readonly IWorkbenchWindowInfo[]> {
		const windows = await this.host.listWindows();
		return options.includeAuxiliaryWindows ? windows : windows.filter(window => window.kind !== 'auxiliary');
	}

	public override restart(): Promise<void> { return invoke<void>(HOST_RESTART_CHANNEL); }

	public override getScreenshot(rect?: IRectangle): Promise<VSBuffer | undefined> { return this.host.getScreenshot(rect); }

	public override openWindow(options?: IOpenEmptyWindowOptions): Promise<void>;
	public override openWindow(toOpen: readonly IWindowOpenable[], options?: IOpenWindowOptions): Promise<void>;
	public override openWindow(toOpenOrOptions: readonly IWindowOpenable[] | IOpenEmptyWindowOptions = {}, options: IOpenWindowOptions = {}): Promise<void> {
		if (!Array.isArray(toOpenOrOptions)) return this.host.openWindow(toOpenOrOptions as IOpenEmptyWindowOptions);
		if (IsSessionsWindowContext.isEqualTo(true).evaluate(this.contexts.getContext())) throw new Error(localize('workspace.openUnavailable', 'Opening workspaces is unavailable in this host.'));
		if (toOpenOrOptions.length !== 1) throw new Error(localize('workspace.oneWindowTarget', 'Open one workspace per window request.'));
		const target = toOpenOrOptions[0]!;
		return this.host.openWorkspace(('workspaceUri' in target ? target.workspaceUri : target.folderUri).fsPath, options.forceNewWindow === true);
	}
}
