import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { localize, localize2 } from '../../../../nls.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { validateTerminalWindowTransferMove } from '../../../../platform/native/common/nativeHost.js';
import type { ITerminalReconnectLease } from '../../../../platform/terminal/common/terminal.js';
import { INativeHostService } from '../../../common/services.js';
import { ITerminalService, type ITerminalInstance } from '../browser/terminal.js';
import { TerminalCommandId } from '../common/terminal.js';
import { TerminalHasActiveInstanceContext } from '../common/terminalContextKey.js';
import { parseTerminalReloadState } from '../common/terminalStorageKeys.js';
import { terminalExecutionScope, terminalExecutionScopesEqual } from '../common/remote/terminal.js';
import type { ITerminalSerializedState } from '../../../services/terminal/common/terminal.js';
import './localTerminalBackend.js';
import { registerRemoteContributions } from './terminalRemote.js';
import { ElectronTerminalProfileResolverService } from './terminalProfileResolverService.js';
import { registerWorkbenchServiceContribution } from '../../../browser/workbenchServiceContributions.js';
import { ITerminalProfileResolverService, ITerminalProfileService } from '../common/terminal.js';
import { ITerminalProcessService } from '../../../../platform/terminal/common/terminal.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IConfigurationResolverService } from '../../../services/configurationResolver/common/configurationResolver.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEnvironmentVariableService } from '../common/environmentVariable.js';

import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { TerminalNativeContribution } from './terminalNativeContribution.js';

registerWorkbenchContribution(TerminalNativeContribution.ID, WorkbenchPhase.BlockRestore, accessor =>
	accessor.get(IInstantiationService).createInstance(TerminalNativeContribution),
);

registerRemoteContributions();

registerWorkbenchServiceContribution({
	service: ITerminalProfileResolverService,
	dependencies: [
		ITerminalProfileService,
		ITerminalProcessService,
		IConfigurationService,
		IConfigurationResolverService,
		IWorkspaceContextService,
		IEnvironmentVariableService,
	],
	install: context => context.register(context.container.createInstance(ElectronTerminalProfileResolverService)),
});

// A transfer owns a paused source client until Main acknowledges target attachment.
// This set tracks only in-flight commands; terminal membership remains service-owned.
const movingTerminals = new WeakSet<ITerminalInstance>();

registerAction2(
	class MoveTerminalIntoNewWindowAction extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.MoveIntoNewWindow,
				title: localize2('terminal.moveIntoNewWindow', 'Terminal: Move Terminal into New Window'),
				f1: true,
				precondition: TerminalHasActiveInstanceContext.isEqualTo(true),
			});
		}

		override async run(accessor: ServicesAccessor, targetWindowId?: unknown): Promise<void> {
			if (
				targetWindowId !== undefined &&
				(!Number.isSafeInteger(targetWindowId) || (targetWindowId as number) <= 0)
			)
				throw new TypeError('Invalid terminal transfer target');
			const terminals = accessor.get(ITerminalService);
			const instance = terminals.activeInstance;
			if (!instance || movingTerminals.has(instance)) return;
			const processes = accessor.get(ITerminalProcessService);
			const nativeHost = accessor.get(INativeHostService);
			const workspace = accessor.get(IWorkspaceContextService);
			const log = accessor.get(ILogService);
			if (
				!processes.detach ||
				!processes.attach ||
				!processes.getReconnectLease ||
				instance.isReadOnly ||
				instance.state !== 'running' ||
				instance.shellLaunchConfig?.customPtyImplementation
			) {
				throw new Error(
					localize(
						'terminal.windowTransfer.unsupported',
						'This terminal cannot move its process to another window.',
					),
				);
			}
			const scope = terminalExecutionScope(workspace.getWorkspace());
			const assertCurrent = (): void => {
				if (
					!terminals.instances.includes(instance) ||
					!terminalExecutionScopesEqual(scope, terminalExecutionScope(workspace.getWorkspace()))
				)
					throw new CancellationError();
			};
			movingTerminals.add(instance);
			let snapshot: ITerminalSerializedState | undefined;
			let lease: ITerminalReconnectLease | undefined;
			let delivered = false;
			try {
				snapshot = await instance.serializeState();
				assertCurrent();
				const state = JSON.stringify({
					version: 1,
					workspaceId: scope.workspaceId,
					remoteAuthority: scope.remoteAuthority,
					instances: [snapshot],
					groups: [],
					activeId: snapshot.instanceId,
				});
				parseTerminalReloadState(state);
				const id = generateUuid();
				const currentLease = await processes.getReconnectLease(snapshot.process.terminalId);
				if (!currentLease)
					throw new Error(
						localize(
							'terminal.windowTransfer.unsupported',
							'This terminal cannot move its process to another window.',
						),
					);
				// Check native payload bounds before detaching the execution owner.
				validateTerminalWindowTransferMove({
					transfer: { id, state, lease: currentLease },
					...(targetWindowId === undefined ? {} : { targetWindowId }),
				});
				assertCurrent();
				lease = await processes.detach(snapshot.process.terminalId);
				assertCurrent();
				const result = await nativeHost.moveTerminalToWindow(
					{ id, state, lease },
					targetWindowId as number | undefined,
				);
				if (result.id !== id)
					throw new Error(
						localize(
							'terminal.windowTransfer.invalidReply',
							'The terminal window returned an invalid transfer acknowledgement.',
						),
					);
				if (result.error) {
					lease = result.lease ?? lease;
					throw new Error(result.error);
				}
				delivered = true;
				await instance.close();
			} catch (error) {
				if (!delivered) {
					try {
						if (lease && snapshot) {
							const restored = await processes.attach(
								lease,
								{ rows: snapshot.rows, cols: snapshot.cols },
								snapshot.process.profile,
							);
							if (restored.ready.pid !== snapshot.process.ready.pid)
								throw new Error(
									localize(
										'terminal.windowTransfer.processChanged',
										'The terminal process changed during window transfer.',
									),
								);
							if (!terminals.instances.includes(instance)) {
								await processes.close({ terminalId: restored.terminalId, dirId: lease.dirId });
								throw new CancellationError();
							}
						}
						instance.start();
					} catch (rollbackError) {
						log.error(
							'terminal',
							localize(
								'terminal.windowTransfer.rollbackFailed',
								'Could not restore the terminal after its window transfer failed.',
							),
							rollbackError,
						);
						await instance.close().catch(closeError => log.error('terminal', closeError));
					}
				}
				throw error;
			} finally {
				movingTerminals.delete(instance);
			}
		}
	},
);
