import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { CancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ITerminalProcessService, type ICreateContributedTerminalProfileOptions } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEmbedderTerminalService, type EmbedderTerminal } from '../../../services/terminal/common/embedderTerminalService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import type { IWorkbenchContribution } from '../../../common/contributions.js';
import { ITerminalService } from './terminal.js';
import { ITerminalProfileResolverService, ITerminalProfileService, TERMINAL_VIEW_ID } from '../common/terminal.js';
import { terminalExecutionScope } from '../common/remote/terminal.js';

/** Connects host terminal requests and profiles to the window's instance and view owners. */
export class TerminalMainContribution extends Disposable implements IWorkbenchContribution {
	public static readonly ID = 'terminalMain';
	private readonly profileRegistration = this._register(new MutableDisposable<DisposableStore>());
	private generation = 0;
	private ready = false;

	constructor(
		@IEmbedderTerminalService embedderTerminals: IEmbedderTerminalService,
		@ITerminalService private readonly terminals: ITerminalService,
		@IViewsService private readonly views: IViewsService,
		@ITerminalProfileService private readonly profiles: ITerminalProfileService,
		@ITerminalProfileResolverService private readonly resolver: ITerminalProfileResolverService,
		@ITerminalProcessService private readonly processes: ITerminalProcessService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) {
		super();
		this._register(embedderTerminals.onDidCreateTerminal(config => {
			void this.createTerminal(config as EmbedderTerminal).catch(onUnexpectedError);
		}));
		this._register(workspace.onDidChangeWorkspace(() => this.updateProfile()));
		let connectionRevision = 0;
		this._register(processes.onConnectionState(state => {
			connectionRevision++;
			this.ready = state === 'ready';
			this.updateProfile();
		}));
		const initialRevision = connectionRevision;
		void processes.getConnectionState().then(state => {
			if (this.isDisposed || initialRevision !== connectionRevision) return;
			this.ready = state === 'ready';
			this.updateProfile();
		}).catch(onUnexpectedError);
	}

	private updateProfile(): void {
		const generation = ++this.generation;
		this.profileRegistration.clear();
		if (!this.ready || this.isDisposed) return;
		const scope = terminalExecutionScope(this.workspace.getWorkspace());
		const name = scope.remoteAuthority ?? localize('terminal.agentHost.local', 'Local');
		const title = localize('terminal.agentHost.profile', 'Agent Host ({0})', name);
		const registration = new DisposableStore();
		this.profileRegistration.value = registration;
		registration.add(this.profiles.registerTerminalProfileProvider('ash.code', 'cli', {
			createContributedTerminalProfile: options => this.createAshCodeTerminal(options, generation),
		}));
		registration.add(this.profiles.registerInternalContributedProfile({
			extensionIdentifier: 'ash.code', id: 'cli', title: localize('terminal.ashCode.profile', 'Ash Code'),
		}));
		const id = scope.remoteAuthority ?? 'local';
		registration.add(this.profiles.registerTerminalProfileProvider('ash.agent-host', id, {
			createContributedTerminalProfile: options => this.createAgentTerminal(options, title, generation),
		}));
		registration.add(this.profiles.registerInternalContributedProfile({
			extensionIdentifier: 'ash.agent-host', id, title,
		}));
	}

	private async createAshCodeTerminal(options: ICreateContributedTerminalProfileOptions, generation: number): Promise<number> {
		const assertCurrent = (): void => {
			if (this.isDisposed || generation !== this.generation) throw new CancellationError();
		};
		assertCurrent();
		// Resolve the user's shell on the execution host. Bypass contributed defaults
		// so selecting Ash Code as the default cannot recursively invoke this provider.
		const instance = await this.terminals.createTerminal({
			config: { name: 'Ash Code', icon: options.icon, color: options.color },
			cwd: options.cwd, location: options.location, preserveFocus: options.preserveFocus,
			skipContributedProfileCheck: true,
		});
		try {
			assertCurrent();
			await instance.sendText('ash code', true);
			assertCurrent();
			return instance.instanceId;
		} catch (error) {
			await this.terminals.closeTerminal(instance);
			throw error;
		}
	}

	private async createAgentTerminal(options: ICreateContributedTerminalProfileOptions, title: string, generation: number): Promise<number> {
		const assertCurrent = (): void => {
			if (this.isDisposed || generation !== this.generation) throw new CancellationError();
		};
		assertCurrent();
		const os = this.processes.operatingSystem;
		if (os === undefined) throw new CancellationError();
		const resource = URI.isUri(options.cwd) ? options.cwd : typeof options.cwd === 'string' ? URI.file(options.cwd) : undefined;
		const folder = resource ? this.workspace.getWorkspaceFolder(resource) ?? undefined : undefined;
		const scope = terminalExecutionScope(this.workspace.getWorkspace());
		const profile = await this.resolver.getDefaultProfile({
			os, workspaceFolder: folder, remoteAuthority: scope.remoteAuthority, allowAgentHostShell: true,
		});
		assertCurrent();
		// Pass explicit shell intent through the regular creation owner so global
		// environment settings, workspace selection and collections apply once.
		const instance = await this.terminals.createTerminal({
			config: {
				name: title, executable: profile.path, args: profile.args, env: profile.env,
				icon: options.icon ?? profile.icon, color: options.color ?? profile.color,
			},
			cwd: options.cwd, location: options.location, preserveFocus: options.preserveFocus,
		});
		try {
			assertCurrent();
			return instance.instanceId;
		} catch (error) {
			await this.terminals.closeTerminal(instance);
			throw error;
		}
	}

	private async createTerminal(config: EmbedderTerminal): Promise<void> {
		const instance = await this.terminals.createTerminal({ config, dimensions: { cols: 80, rows: 24 } });
		if (this.isDisposed || !this.terminals.instances.includes(instance)) {
			await instance.close();
			return;
		}
		this.terminals.setActiveInstance(instance);
		await this.views.openView(TERMINAL_VIEW_ID, true);
	}
}
