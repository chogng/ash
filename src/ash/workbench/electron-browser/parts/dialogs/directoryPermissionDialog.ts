import { addDisposableListener } from '../../../../base/browser/dom.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isRecord } from '../../../../base/common/types.js';
import { DialogResult, type DialogRequest } from '../../../../platform/dialogs/common/dialogs.js';
import type {
	IDirectoryPermissionRequestService,
	WorkspaceTrustChoice,
} from '../../../../platform/workspace/common/workspaceTrust.js';
import { invoke } from '../../../../platform/ipc/electron-browser/rendererIpc.js';
import { ManagedStyleSheet } from '../../../../base/browser/domStylesheets.js';
import { generateColorThemeCSS } from '../../../services/themes/browser/colorThemeCss.js';
import { darkColorTheme, lightColorTheme } from '../../../../platform/theme/common/colorTheme.js';
import { BrowserDialogHandler } from '../../../browser/parts/dialogs/dialog.js';

/** Presents directory authorization in the window before or after Workbench startup. */
export class DirectoryPermissionDialog extends Disposable implements IDirectoryPermissionRequestService {
	private readonly activeRequest = this._register(new MutableDisposable<DisposableStore>());
	private readonly handler: BrowserDialogHandler;

	constructor(private readonly container: HTMLElement) {
		super();
		this.handler = new BrowserDialogHandler(container);
	}

	public async requestDirectoryPermissions(path: string, signal?: AbortSignal): Promise<WorkspaceTrustChoice> {
		this.assertNotDisposed();
		if (signal) throwIfCancelled(signal);
		if (this.activeRequest.value) throw new Error('Directory permission selection is already in progress');
		const controller = new AbortController();
		const ownerWindow = this.container.ownerDocument.defaultView;
		if (!ownerWindow) throw new Error('Directory permission dialog requires a window');
		const resources = (this.activeRequest.value = new DisposableStore());
		resources.add(toDisposable(() => controller.abort()));
		const cancel = (): void => {
			controller.abort(signal?.reason);
			// Free the slot synchronously, before a replacement connection can request its prompt.
			if (this.activeRequest.value === resources) this.activeRequest.clear();
		};
		if (signal) resources.add(addDisposableListener(signal, 'abort', cancel, { once: true }));
		resources.add(addDisposableListener(ownerWindow, 'pagehide', cancel, { once: true }));
		try {
			const prompt = parseDirectoryPermissionPrompt(
				await raceCancellationError(
					invoke<unknown>('ash:host:directoryPermissionPrompt', path),
					controller.signal,
				),
			);
			throwIfCancelled(controller.signal);
			if (!this.container.hasAttribute('data-color-theme')) {
				const theme = ownerWindow.matchMedia('(prefers-color-scheme: dark)').matches
					? darkColorTheme
					: lightColorTheme;
				resources.add(
					new ManagedStyleSheet(this.container.ownerDocument, generateColorThemeCSS(theme, ':root').code),
				);
			}
			const outcome = await this.handler.showDialog(prompt, controller.signal);
			throwIfCancelled(controller.signal);
			switch (outcome.button) {
				case DialogResult.Primary:
					return 'readOnly';
				case DialogResult.Secondary:
					return 'development';
				default:
					return 'cancel';
			}
		} finally {
			if (this.activeRequest.value === resources) this.activeRequest.clear();
		}
	}
}

function parseDirectoryPermissionPrompt(value: unknown): Extract<DialogRequest, { readonly kind: 'prompt' }> {
	if (
		!isRecord(value) ||
		value.kind !== 'prompt' ||
		Object.keys(value).sort().join(',') !==
			'cancelButton,detail,kind,message,primaryButton,secondaryButton,title' ||
		typeof value.title !== 'string' ||
		typeof value.message !== 'string' ||
		typeof value.detail !== 'string' ||
		typeof value.primaryButton !== 'string' ||
		typeof value.secondaryButton !== 'string' ||
		typeof value.cancelButton !== 'string'
	) {
		throw new TypeError('Invalid directory permission prompt');
	}
	return value as unknown as Extract<DialogRequest, { readonly kind: 'prompt' }>;
}
