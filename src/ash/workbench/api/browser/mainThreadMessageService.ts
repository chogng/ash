import { throwIfCancelled } from '../../../base/common/cancellation.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { OPEN_EXTENSIONS_COMMAND_ID } from '../../../platform/extensionManagement/common/extensionManagementService.js';
import { IExtensionApi } from '../../../platform/extensions/common/extensionApi.js';
import { INotificationService, Severity, type INotificationHandle } from '../../../platform/notification/common/notification.js';
import type { ExtensionClientOperation, ExtensionClientResult } from '../common/extHost.protocol.js';

/** Adapts extension messages to the window's notification owner and returns button selections. */
export class MainThreadMessageService extends Disposable {
	private readonly pending = this._register(new DisposableMap<INotificationHandle, DisposableStore>());

	constructor(
		@INotificationService private readonly notifications: INotificationService,
		@IExtensionApi private readonly extensions: IExtensionApi,
		@ICommandService private readonly commands: ICommandService,
	) {
		super();
	}

	public async handle(operation: Extract<ExtensionClientOperation, { operation: 'showMessage'; }>, extensionId: string, signal: AbortSignal): Promise<ExtensionClientResult> {
		const choices = operation.items ?? [];
		if (choices.length > 16 || choices.some(item => typeof item !== 'string' || !item.trim() || item.length > 512)) {
			throw new TypeError('Extension messages require at most 16 non-empty button labels');
		}
		let label = extensionId;
		try {
			const catalog = await this.extensions.list('cached');
			label = catalog.extensions.find(extension => extension.id.toLowerCase() === extensionId.toLowerCase())?.displayName || extensionId;
		} catch {
			// Catalog failures must not hide the original message; the authenticated identity remains usable.
		}
		throwIfCancelled(signal);
		this.assertNotDisposed();
		const severity = operation.severity === 'information' ? Severity.Info : operation.severity === 'warning' ? Severity.Warning : Severity.Error;
		let select: (index: number | null) => void = () => { };
		const selection = new Promise<ExtensionClientResult>(resolve => { select = index => resolve({ result: 'selection', index }); });
		const handle = this.notifications.notify({
			severity,
			message: operation.message,
			source: { id: extensionId, label },
			actions: {
				primary: choices.map((title, index) => ({
					tooltip: '',
					enabled: true,
					id: `extension.message.${index}`, label: title,
					run: () => { select(index); handle.close(); },
				})),
				secondary: [{
					tooltip: '',
					enabled: true,
					id: 'extension.manage',
					label: localize('notifications.manageExtension', 'Manage Extension'),
					run: async () => { await this.commands.executeCommand(OPEN_EXTENSIONS_COMMAND_ID, { query: extensionId }); },
				}],
			},
		});
		if (!choices.length) return { result: 'done' };
		if (this.isDisposed || signal.aborted) {
			handle.close();
			return { result: 'selection', index: null };
		}
		const lifetime = this.pending.set(handle, new DisposableStore());
		// Removal, cancellation and window disposal all settle the extension's outstanding choice.
		lifetime.add(toDisposable(() => { select(null); handle.close(); }));
		lifetime.add(handle.onDidClose(() => select(null)));
		const cancel = (): void => { select(null); handle.close(); };
		signal.addEventListener('abort', cancel, { once: true });
		lifetime.add(toDisposable(() => signal.removeEventListener('abort', cancel)));
		if (signal.aborted) cancel();
		try {
			return await selection;
		} finally {
			this.pending.deleteAndDispose(handle);
		}
	}
}
