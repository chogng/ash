import { addDisposableListener } from '../../../../base/browser/dom.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isRecord } from '../../../../base/common/types.js';
import { DialogResult, type DialogRequest } from '../../../../platform/dialogs/common/dialogs.js';
import type { IWorkspaceTrustRequestService, WorkspaceTrustChoice } from '../../../../platform/workspace/common/workspaceTrust.js';
import { invoke } from '../../../../platform/ipc/electron-browser/rendererIpc.js';
import { bindColorTheme } from '../../../../platform/theme/browser/themeStyles.js';
import { darkColorTheme, lightColorTheme } from '../../../../platform/theme/common/colorTheme.js';
import { defaultProductIconTheme, type IThemeService } from '../../../../platform/theme/common/themeService.js';
import { BrowserDialogHandler } from '../../../browser/parts/dialogs/dialogHandler.js';

/** Presents directory authorization in the window before or after Workbench startup. */
export class DirectoryPermissionDialog extends Disposable implements IWorkspaceTrustRequestService {
	private readonly activeRequest = this._register(new MutableDisposable<DisposableStore>());
	private readonly handler: BrowserDialogHandler;

	constructor(private readonly container: HTMLElement) {
		super();
		this.handler = new BrowserDialogHandler(container);
	}

	public async requestWorkspaceTrust(path: string): Promise<WorkspaceTrustChoice> {
		this.assertNotDisposed();
		if (this.activeRequest.value) throw new Error('Directory permission selection is already in progress');
		const prompt = parseDirectoryPermissionPrompt(await invoke<unknown>('ash:host:directoryPermissionPrompt', path));
		const controller = new AbortController();
		const ownerWindow = this.container.ownerDocument.defaultView;
		if (!ownerWindow) throw new Error('Directory permission dialog requires a window');
		const resources = this.activeRequest.value = new DisposableStore();
		resources.add(toDisposable(() => controller.abort()));
		resources.add(addDisposableListener(ownerWindow, 'pagehide', () => controller.abort(), { once: true }));
		try {
			if (!this.container.hasAttribute('data-color-theme')) {
				const theme = ownerWindow.matchMedia('(prefers-color-scheme: dark)').matches ? darkColorTheme : lightColorTheme;
				const service: IThemeService = {
					onDidColorThemeChange: Event.None,
					onDidProductIconThemeChange: Event.None,
					getColorTheme: () => theme,
					getProductIconTheme: () => defaultProductIconTheme,
				};
				resources.add(bindColorTheme(service, this.container));
			}
			const outcome = await this.handler.showDialog(prompt, controller.signal);
			switch (outcome.button) {
				case DialogResult.Primary: return 'readOnly';
				case DialogResult.Secondary: return 'development';
				default: return 'cancel';
			}
		} finally {
			this.activeRequest.clear();
		}
	}
}

function parseDirectoryPermissionPrompt(value: unknown): Extract<DialogRequest, { readonly kind: 'prompt' }> {
	if (!isRecord(value) || value.kind !== 'prompt'
		|| Object.keys(value).sort().join(',') !== 'cancelButton,detail,kind,message,primaryButton,secondaryButton,title'
		|| typeof value.title !== 'string' || typeof value.message !== 'string'
		|| typeof value.detail !== 'string' || typeof value.primaryButton !== 'string'
		|| typeof value.secondaryButton !== 'string' || typeof value.cancelButton !== 'string') {
		throw new TypeError('Invalid directory permission prompt');
	}
	return value as unknown as Extract<DialogRequest, { readonly kind: 'prompt' }>;
}
