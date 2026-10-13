import { getRemoteAuthority } from '../../../../platform/remote/common/remoteHosts.js';
import { BaseTerminalProfileResolverService } from '../browser/terminalProfileResolverService.js';

/** An empty Desktop remote window retains its host even before a folder is opened. */
export class ElectronTerminalProfileResolverService extends BaseTerminalProfileResolverService {
	protected getExecutionAuthority(): string | undefined {
		const workspace = this.workspace.getWorkspace();
		return workspace.remoteAuthority ?? (workspace.folders[0] && getRemoteAuthority(workspace.folders[0].uri));
	}
}
