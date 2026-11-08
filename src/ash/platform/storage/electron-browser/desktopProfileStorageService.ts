import { APP_SERVER_METHODS } from '../../../../../.build/protocol/typescript/index.js';
import { CancellationTokenSource, throwIfCancelled } from '../../../base/common/cancellation.js';
import type { IChannel } from '../../../base/parts/ipc/common/ipc.js';
import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import type { DesktopStorageUsage, IProfileStorageService, ProfileStorageOverview, ProfileStorageWorktree } from '../common/profileStorageService.js';

export class DesktopProfileStorageService implements IProfileStorageService {
	declare readonly _serviceBrand: undefined;

	constructor(private readonly connection: AppServerProtocolClient, private readonly desktop: IChannel) { }

	async readOverview(signal: AbortSignal): Promise<ProfileStorageOverview> {
		const { worktrees, ...overview } = await this.connection.request(APP_SERVER_METHODS['storage/overview'], {}, { signal });
		throwIfCancelled(signal);
		using cancellation = new CancellationTokenSource();
		const cancel = () => cancellation.cancel();
		signal.addEventListener('abort', cancel, { once: true });
		let desktop: DesktopStorageUsage | undefined;
		try {
			desktop = await this.desktop.call<DesktopStorageUsage>('measure', overview.worktreeRoot, cancellation.token);
		} catch {
			throwIfCancelled(signal);
		} finally {
			signal.removeEventListener('abort', cancel);
		}
		return {
			...overview, desktopRoot: desktop?.root, otherBytes: overview.otherBytes + (desktop?.bytes ?? 0), complete: overview.complete && (desktop?.complete ?? false), worktrees: worktrees.map(({ title, identity, sizeBytes }) => ({
				title, sizeBytes, sessionId: identity.sessionId, threadId: identity.threadId, path: identity.checkoutRoot, revision: identity.expectedSequence,
			}))
		};
	}

	async cleanWorktree(worktree: ProfileStorageWorktree): Promise<void> {
		await this.connection.request(APP_SERVER_METHODS['storage/worktree/cleanup'], {
			sessionId: worktree.sessionId, threadId: worktree.threadId, checkoutRoot: worktree.path, expectedSequence: worktree.revision,
		});
	}
}
