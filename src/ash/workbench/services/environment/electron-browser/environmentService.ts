import { Schemas } from '../../../../base/common/network.js';
import type { IWorkbenchEnvironmentService } from '../common/environmentService.js';

export class ElectronWorkbenchEnvironmentService implements IWorkbenchEnvironmentService {
	public readonly webviewExternalEndpoint = `${Schemas.vscodeWebview}://{{uuid}}`;
}
