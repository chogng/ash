import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { MenuId, MenusRegistry } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { normalizeRemoteWorkspacePath } from '../../../../../platform/remote/common/remote.js';
import { IRendererHostService, type IRendererHost } from '../../../../../platform/renderer/common/rendererHost.js';

/** Selects a real WSL distribution; connection and provider lifetimes remain with their existing owners. */
export class WSLAgentHostContribution extends Disposable {
	public static readonly ID = 'sessions.contrib.wslAgentHostContribution';
	private readonly pending = this._register(new DisposableStore());
	constructor(
		@IRendererHostService private readonly renderer: IRendererHost,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		if (!renderer.agentHosts) return;
		const id = 'sessions.action.connectWSLAgentHost';
		this._register(CommandsRegistry.register(id, () => this.connect()));
		this._register(MenusRegistry.appendMenuItem(MenuId.CommandPalette, { command: { id, title: localize2('sessions.hosts.connectWSL', 'Agents: Connect to WSL…') } }));
	}

	private async connect(): Promise<void> {
		const resources = this.pending.add(new DisposableStore());
		const cancellation = new CancellationTokenSource();
		resources.add(toDisposable(() => cancellation.dispose(true)));
		const controller = new AbortController();
		resources.add(toDisposable(() => controller.abort()));
		try {
			const distros = await this.renderer.agentHosts!.listWSLDistros();
			if (resources.isDisposed || this.isDisposed) return;
			if (!distros.length) {
				this.notifications.info(localize('sessions.hosts.noWSL', 'No WSL 2 distributions are available. WSL connections require Windows and an installed Ash Remote runtime in the distribution.'));
				return;
			}
			const picker = resources.add(this.quickInput.createQuickPick<{ label: string; }>());
			picker.items = distros.map(label => ({ label }));
			picker.placeholder = picker.ariaLabel = localize('sessions.hosts.selectWSL', 'Select a WSL 2 distribution');
			const distro = await new Promise<string | undefined>(resolve => {
				resources.add(toDisposable(() => resolve(undefined)));
				resources.add(picker.onDidAccept(() => { resolve(picker.selectedItems[0]?.label); picker.hide(); }));
				resources.add(picker.onDidHide(() => resolve(undefined)));
				picker.show();
			});
			if (!distro || resources.isDisposed) return;
			const workspace = await this.quickInput.input({
				title: localize('sessions.hosts.wslWorkspace', 'Workspace in {0}', distro), placeHolder: '/home/user/project',
				validateInput: async value => {
					try { if (!value.startsWith('/')) throw new Error(); normalizeRemoteWorkspacePath(value); return undefined; }
					catch { return localize('sessions.hosts.absolutePath', 'Enter an absolute workspace path.'); }
				},
			}, cancellation.token);
			if (!workspace || resources.isDisposed) return;
			await this.renderer.agentHosts!.connect({ type: 'wsl', name: distro, distro, workspace }, controller.signal);
		} catch (error) {
			if (!this.isDisposed && !controller.signal.aborted && !isCancellationError(error)) this.notifications.error(error instanceof Error ? error : String(error));
		} finally { this.pending.delete(resources); resources.dispose(); }
	}
}
