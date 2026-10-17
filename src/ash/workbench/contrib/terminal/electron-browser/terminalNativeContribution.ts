import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import type { IWorkbenchContribution } from '../../../common/contributions.js';
import { ILifecycleService, LifecyclePhase, type ShutdownReason } from '../../../services/lifecycle/common/lifecycle.js';
import { ITerminalService, ITerminalGroupService, type ITerminalInstance } from '../../../services/terminal/browser/terminal.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ProcessPropertyType, ITerminalProcessService } from '../../../../platform/terminal/common/terminal.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { parseTerminalReloadCredentials, parseTerminalReloadState, TerminalStorageKeys } from '../common/terminalStorageKeys.js';
import type { ITerminalReloadState } from '../../../services/terminal/common/terminal.js';
import { terminalExecutionScope } from '../common/remote/terminal.js';

/** Desktop's leased PTYs must receive shutdown before the renderer's IPC lifetime ends. */
export class TerminalNativeContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'terminal.native';
	private readonly prepared = new Set<ITerminalInstance>();
	private checkpointKey: string | undefined;

	constructor(
		@ITerminalService private readonly terminals: ITerminalService,
		@ILifecycleService lifecycle: ILifecycleService,
		@ILogService private readonly log: ILogService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IDialogService private readonly dialogs: IDialogService,
		@ITerminalGroupService private readonly groups: ITerminalGroupService,
		@ITerminalProcessService private readonly processes: ITerminalProcessService,
		@ISecretStorageService private readonly secrets: ISecretStorageService,
		@IStorageService private readonly storage: IStorageService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) {
		super();
		this._register(lifecycle.onBeforeShutdown(event => event.veto(this.confirmShutdown(event.reason), TerminalNativeContribution.ID)));
		this._register(lifecycle.onWillShutdown(event => event.join(
			() => this.shouldPersist(event.reason) ? this.prepareReload() : this.closeTerminals(),
			localize('terminal.native.closing', 'Closing terminals'),
			() => this.shouldPersist(event.reason) ? this.terminals.instances.every(instance => this.prepared.has(instance)) : this.terminals.instances.length === 0,
		)));
		this._register(lifecycle.onDidShutdown(reason => {
			if (!this.shouldPersist(reason)) return;
			// No veto or failed join can occur beyond this boundary. Earlier preparation
			// must keep the original clients usable in case another participant fails.
			this.processes.prepareForReload?.();
			this.prepared.clear();
		}));
		this._register(lifecycle.onDidShutdownError(() => {
			for (const instance of this.prepared) instance.start();
			this.prepared.clear();
			void this.clearCheckpoint().catch(error => this.log.error('terminal', error));
		}));
		void this.restoreLayout(lifecycle).catch(error => this.log.error('terminal', localize('terminal.reload.failed', 'Could not restore terminal sessions after reload.'), error));
	}

	private shouldPersist(reason: ShutdownReason): boolean {
		return reason === 'reload' && this.configuration.getValue<boolean>('terminal.integrated.enablePersistentSessions') !== false;
	}

	private async confirmShutdown(reason: ShutdownReason): Promise<boolean> {
		if (this.shouldPersist(reason)) return false;
		const instances = [...this.terminals.instances].filter(instance => !instance.isReadOnly && instance.state !== 'exited');
		if (!instances.length) return false;
		const policy = this.configuration.getValue<string>('terminal.integrated.confirmOnExit') ?? 'never';
		if (policy === 'never') return false;
		if (policy === 'hasChildProcesses' && !(await Promise.all(instances.map(instance => instance.refreshProperty(ProcessPropertyType.HasChildProcesses).catch(() => true)))).some(Boolean)) return false;
		return !(await this.dialogs.confirm({
			message: localize('terminal.confirmExit', 'Close the window and terminate its terminal sessions?'),
			detail: localize('terminal.confirmExitDetail', '{0} terminal session(s) will be closed. Running processes will stop.', instances.length),
			primaryButton: localize('terminal.closeWindow', 'Close Window'),
		})).confirmed;
	}

	private async prepareReload(): Promise<void> {
		await this.terminals.whenConnected;
		const instances = [...this.terminals.instances];
		const activeId = this.terminals.activeInstance?.instanceId;
		const focusedId = instances.find(instance => {
			const element = instance.xterm?.element;
			return element?.contains(element.ownerDocument.activeElement);
		})?.instanceId;
		const snapshots = [];
		for (const instance of instances) {
			if (instance.shellLaunchConfig?.customPtyImplementation) throw new Error(localize('terminal.reload.unsupported', 'This terminal cannot preserve its process across a window reload.'));
			// Register before awaiting: even a failed checkpoint must resume this client.
			this.prepared.add(instance);
			snapshots.push(await instance.serializeState());
		}
		const leases = await Promise.all(snapshots.map(async snapshot => {
			const lease = await this.processes.getReconnectLease?.(snapshot.process.terminalId);
			if (!lease) throw new Error(localize('terminal.reload.leaseUnavailable', 'The terminal process cannot be reattached after reload.'));
			return lease;
		}));
		const scope = terminalExecutionScope(this.workspace.getWorkspace());
		const state: ITerminalReloadState = {
			version: 1, workspaceId: scope.workspaceId, remoteAuthority: scope.remoteAuthority, instances: snapshots, activeId, focusedId,
			groups: this.groups.groups.map(group => {
				const layout = group.getLayoutInfo(group === this.groups.activeGroup);
				return { ids: layout.terminals.map(pane => pane.terminal), sizes: layout.terminals.map(pane => pane.relativeSize) };
			}),
		};
		const text = JSON.stringify(state);
		parseTerminalReloadState(text);
		this.checkpointKey ??= `${TerminalStorageKeys.Reload}.${generateUuid()}`;
		this.storage.store(this.checkpointKey, text, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		await this.storage.flush();
		await this.secrets.set(TerminalStorageKeys.Reload, JSON.stringify({ stateKey: this.checkpointKey, expiresAt: Date.now() + 300000, leases }));
	}

	private async restoreLayout(lifecycle: ILifecycleService): Promise<void> {
		await this.terminals.whenConnected;
		if (this.isDisposed) return;
		const encoded = await this.secrets.get(TerminalStorageKeys.Reload);
		if (!encoded) return;
		const credentials = parseTerminalReloadCredentials(encoded);
		this.checkpointKey = credentials.stateKey;
		const text = this.storage.get(credentials.stateKey, StorageScope.WORKSPACE);
		if (text && credentials.expiresAt >= Date.now()) {
			const state = parseTerminalReloadState(text);
			for (const layout of state.groups) {
				const members = layout.ids.map(id => this.terminals.instances.find(instance => instance.instanceId === id)).filter((instance): instance is ITerminalInstance => !!instance);
				this.groups.joinInstances(members);
				if (members.length === layout.ids.length && members[0]) this.groups.getGroupForInstance(members[0])?.resizePanes([...layout.sizes]);
			}
			const active = this.terminals.instances.find(instance => instance.instanceId === state.activeId);
			if (active) this.terminals.setActiveInstance(active);
			await lifecycle.when(LifecyclePhase.Restored);
			if (this.isDisposed || lifecycle.willShutdown) return;
			// Resume only after the saved groups have acquired their final grid sizes.
			// Reading into temporary singleton panes can move the restored cursor while layout reflows.
			for (const snapshot of state.instances) {
				const instance = this.terminals.instances.find(candidate => candidate.instanceId === snapshot.instanceId);
				instance?.xterm?.fit();
				instance?.start();
			}
			const focused = this.terminals.instances.find(instance => instance.instanceId === state.focusedId);
			if (focused?.xterm?.element.isConnected && focused.xterm.element.getBoundingClientRect().width > 0) focused.xterm.focus();
		}
		await this.clearCheckpoint();
	}

	private async clearCheckpoint(): Promise<void> {
		const checkpointKey = this.checkpointKey;
		this.checkpointKey = undefined;
		await this.secrets.delete(TerminalStorageKeys.Reload);
		if (checkpointKey) this.storage.remove(checkpointKey, StorageScope.WORKSPACE);
		await this.storage.flush();
	}

	private async closeTerminals(): Promise<void> {
		const instances = [...this.terminals.instances];
		const results = await Promise.allSettled(instances.map(instance => Promise.resolve().then(() => instance.close())));
		for (const [index, result] of results.entries()) {
			if (result.status === 'rejected') {
				this.log.error('terminal', localize('terminal.native.closeFailed', 'Could not close terminal {0}: {1}', instances[index]!.title, result.reason instanceof Error ? result.reason.message : String(result.reason)));
			}
		}
	}
}
