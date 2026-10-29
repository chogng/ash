import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import type { IWorkbenchContribution } from '../../../common/contributions.js';
import { ILifecycleService, LifecyclePhase, type ShutdownReason } from '../../../services/lifecycle/common/lifecycle.js';
import { TerminalTransferError, ITerminalService, ITerminalGroupService, type ITerminalInstance } from '../browser/terminal.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ProcessPropertyType, ITerminalProcessService, TERMINAL_REVIVE_STATE_KEY } from '../../../../platform/terminal/common/terminal.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { parseTerminalReloadCredentials, parseTerminalReloadState, parseTerminalReviveStateKey, TerminalStorageKeys } from '../common/terminalStorageKeys.js';
import type { ITerminalReloadState } from '../../../services/terminal/common/terminal.js';
import { terminalExecutionScope } from '../common/remote/terminal.js';
import { INativeHostService } from '../../../common/services.js';
import type { INativeHostApi } from '../../../../platform/native/common/nativeHost.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { CancellationError } from '../../../../base/common/errors.js';

/** Desktop's leased PTYs must receive shutdown before the renderer's IPC lifetime ends. */
export class TerminalNativeContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'terminal.native';
	private readonly prepared = new Set<ITerminalInstance>();
	private checkpointKey: string | undefined;
	private receivingTransfer: Promise<void> | undefined;
	private transferRequested = false;

	constructor(
		@ITerminalService private readonly terminals: ITerminalService,
		@ILifecycleService private readonly lifecycle: ILifecycleService,
		@ILogService private readonly log: ILogService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IDialogService private readonly dialogs: IDialogService,
		@ITerminalGroupService private readonly groups: ITerminalGroupService,
		@ITerminalProcessService private readonly processes: ITerminalProcessService,
		@ISecretStorageService private readonly secrets: ISecretStorageService,
		@IStorageService private readonly storage: IStorageService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@INativeHostService private readonly host: INativeHostApi,
	) {
		super();
		this._register(lifecycle.onBeforeShutdown(event => event.veto(this.confirmShutdown(event.reason), TerminalNativeContribution.ID)));
		this._register(lifecycle.onWillShutdown(event => event.join(
			() => this.shouldPersist(event.reason) ? this.prepareReload() : this.prepareExit(event.reason),
			localize('terminal.native.closing', 'Closing terminals'),
			() => this.shouldPersist(event.reason) ? this.terminals.instances.every(instance => !this.canPersist(instance) || this.prepared.has(instance)) : this.terminals.instances.length === 0,
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
			void this.clearCheckpoint(true).catch(error => this.log.error('terminal', error));
		}));
		void this.restoreLayout(lifecycle).catch(error => this.log.error('terminal', localize('terminal.reload.failed', 'Could not restore terminal sessions after reload.'), error));
		const transfers = this.host.onDidRequestTerminalTransfer(() => this.receiveTransfer());
		this._register(toDisposable(() => transfers.dispose()));
		this.receiveTransfer();
	}

	private receiveTransfer(): void {
		if (this.isDisposed) return;
		this.transferRequested = true;
		if (this.receivingTransfer) return;
		this.receivingTransfer = (async () => {
			do {
				this.transferRequested = false;
				await this.acceptTransfer();
			} while (this.transferRequested && !this.isDisposed);
		})().catch(error => this.log.error('terminal', error)).finally(() => this.receivingTransfer = undefined);
	}

	private async acceptTransfer(): Promise<void> {
		await this.terminals.whenConnected;
		if (this.isDisposed) return;
		const transfer = await this.host.takeTerminalTransfer();
		if (!transfer) return;
		let instance: ITerminalInstance | undefined;
		try {
			const state = parseTerminalReloadState(transfer.state);
			const scope = terminalExecutionScope(this.workspace.getWorkspace());
			if (state.kind || state.instances.length !== 1 || state.workspaceId !== scope.workspaceId || state.remoteAuthority !== scope.remoteAuthority) throw new Error('Terminal transfer belongs to another workspace or host');
			instance = await this.terminals.importTerminalState(state.instances[0]!, transfer.lease);
			// Startup restores editor focus after BlockRestore contributions run. Claim
			// the destination's input only once that restore has finished.
			await this.lifecycle.when(LifecyclePhase.Restored);
			if (this.isDisposed || this.lifecycle.willShutdown) throw new CancellationError();
			await this.groups.showPanel(true);
			await this.host.focusWindow();
			instance.start();
			instance.xterm?.focus();
		} catch (error) {
			// Return the rotated credential if attachment succeeded before a later UI failure.
			const lease = error instanceof TerminalTransferError ? error.rollbackLease
				: instance ? await this.processes.detach?.(transfer.lease.terminalId).catch(() => undefined) : undefined;
			if (instance) await instance.close().catch(() => {
				this.log.error('terminal', localize('terminal.windowTransfer.targetFailed', 'Could not initialize the terminal in its destination window.'));
			});
			const message = (error instanceof Error ? error.message : String(error)).slice(0, 2048)
				|| localize('terminal.windowTransfer.targetFailed', 'Could not initialize the terminal in its destination window.');
			await this.host.completeTerminalTransfer({ id: transfer.id, error: message, ...(lease ? { lease } : {}) });
			return;
		}
		// Once attached, this window is the process owner even if the sender disappears.
		await this.host.completeTerminalTransfer({ id: transfer.id });
	}

	private shouldPersist(reason: ShutdownReason): boolean {
		return reason === 'reload' && this.configuration.getValue<boolean>('terminal.integrated.enablePersistentSessions') !== false;
	}

	private canPersist(instance: ITerminalInstance): boolean {
		return instance.state !== 'error' && instance.state !== 'exited' && instance.state !== 'disconnected';
	}

	private async prepareExit(reason: ShutdownReason): Promise<void> {
		const enabled = this.configuration.getValue<boolean>('terminal.integrated.enablePersistentSessions') !== false;
		const policy = this.configuration.getValue<string>('terminal.integrated.persistentSessionReviveProcess') ?? 'onExit';
		const lastWindowExit = reason === 'windowClose' && !isMacintosh && (await this.host.listWindows()).length === 1;
		const revive = enabled && policy !== 'never' && (reason === 'quit' || lastWindowExit || policy === 'onExitAndWindowClose' && reason === 'windowClose');
		try {
			if (revive) await this.prepareReload(true);
			else { this.storage.remove(await this.reviveStateKey(), StorageScope.WORKSPACE); await this.storage.flush(); }
		} catch (error) {
			// Exit terminates these processes regardless of revival support. A failed
			// optional snapshot must not turn a confirmed exit into an endless retry.
			this.log.error('terminal', 'Could not save terminal revival state during shutdown', error);
			try { await this.clearCheckpoint(true); }
			catch (cleanupError) { this.log.error('terminal', 'Could not clear terminal revival state during shutdown', cleanupError); }
		}
		await this.closeTerminals();
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

	private async prepareReload(revive = false): Promise<void> {
		await this.terminals.whenConnected;
		const instances = [...this.terminals.instances];
		const activeId = this.terminals.activeInstance?.instanceId;
		const focusedId = instances.find(instance => {
			const element = instance.xterm?.element;
			return element?.contains(element.ownerDocument.activeElement);
		})?.instanceId;
		const snapshots = [];
		const leases = [];
		for (const instance of instances) {
			if (!this.canPersist(instance)) continue;
			if (revive && (instance.isReadOnly || instance.state !== 'running' || !instance.revivalLaunch)) continue;
			if (instance.shellLaunchConfig?.customPtyImplementation) {
				if (revive) continue;
				throw new Error(localize('terminal.reload.unsupported', 'This terminal cannot preserve its process across a window reload.'));
			}
			// Register before awaiting: even a failed checkpoint must resume this client.
			this.prepared.add(instance);
			const snapshot = await instance.serializeState();
			if (!revive) {
				if (!this.processes.getReconnectLease) throw new Error(localize('terminal.reload.leaseUnavailable', 'The terminal process cannot be reattached after reload.'));
				const lease = await this.processes.getReconnectLease(snapshot.process.terminalId);
				// A runtime replacement can retire the process during screen capture.
				// Keep healthy terminals in the same checkpoint; never persist a dead lease.
				if (!lease) continue;
				leases.push(lease);
			}
			if (!revive || snapshot.launch) snapshots.push(snapshot);
		}
		const scope = terminalExecutionScope(this.workspace.getWorkspace());
		const ids = new Set(snapshots.map(snapshot => snapshot.instanceId));
		const state: ITerminalReloadState = {
			version: 1, ...(revive ? { kind: 'revive' as const } : {}), workspaceId: scope.workspaceId, remoteAuthority: scope.remoteAuthority, instances: snapshots,
			activeId: activeId && ids.has(activeId) ? activeId : undefined, focusedId: focusedId && ids.has(focusedId) ? focusedId : undefined,
			groups: this.groups.groups.map(group => {
				const layout = group.getLayoutInfo(group === this.groups.activeGroup);
				const panes = layout.terminals.filter(pane => ids.has(pane.terminal));
				return { ids: panes.map(pane => pane.terminal), sizes: panes.map(pane => pane.relativeSize) };
			}).filter(group => group.ids.length),
		};
		const text = JSON.stringify(state);
		parseTerminalReloadState(text);
		if (revive) {
			this.storage.store(await this.reviveStateKey(), text, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			await this.storage.flush();
			return;
		}
		this.checkpointKey ??= `${TerminalStorageKeys.Reload}.${generateUuid()}`;
		this.storage.store(this.checkpointKey, text, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		await this.storage.flush();
		await this.secrets.set(TerminalStorageKeys.Reload, JSON.stringify({ stateKey: this.checkpointKey, expiresAt: Date.now() + 300000, leases }));
	}

	private async restoreLayout(lifecycle: ILifecycleService): Promise<void> {
		await this.terminals.whenConnected;
		if (this.isDisposed) return;
		const encoded = await this.secrets.get(TerminalStorageKeys.Reload);
		const credentials = encoded ? parseTerminalReloadCredentials(encoded) : undefined;
		this.checkpointKey = credentials?.stateKey;
		const text = this.storage.get(credentials?.stateKey ?? await this.reviveStateKey(), StorageScope.WORKSPACE);
		if (text && (!credentials || credentials.expiresAt >= Date.now())) {
			const state = parseTerminalReloadState(text);
			const scope = terminalExecutionScope(this.workspace.getWorkspace());
			if (state.workspaceId !== scope.workspaceId || state.remoteAuthority !== scope.remoteAuthority) {
				await this.clearCheckpoint(true);
				return;
			}
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
			// The screen retains this focus request until its restored renderer opens in a visible layout.
			if (focused?.xterm?.element.isConnected) focused.xterm.focus();
			// Recovery can succeed for only part of the checkpoint. Keep failed
			// snapshots and unconsumed leases available instead of treating it as complete.
			if (state.instances.some(snapshot => !this.terminals.instances.some(instance => instance.instanceId === snapshot.instanceId))) return;
		}
		await this.clearCheckpoint();
		this.storage.remove(await this.reviveStateKey(), StorageScope.WORKSPACE);
		await this.storage.flush();
	}

	private async reviveStateKey(): Promise<string> {
		return parseTerminalReviveStateKey(await this.secrets.get(TERMINAL_REVIVE_STATE_KEY));
	}

	private async clearCheckpoint(clearRevive = false): Promise<void> {
		const checkpointKey = this.checkpointKey;
		this.checkpointKey = undefined;
		await this.secrets.delete(TerminalStorageKeys.Reload);
		if (checkpointKey) this.storage.remove(checkpointKey, StorageScope.WORKSPACE);
		if (clearRevive) this.storage.remove(await this.reviveStateKey(), StorageScope.WORKSPACE);
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
