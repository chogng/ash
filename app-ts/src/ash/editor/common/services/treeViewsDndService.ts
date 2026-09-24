import type { VSDataTransfer } from '../../../base/common/dataTransfer.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createServiceIdentifier, type ServiceContainer } from '../../../platform/instantiation/common/instantiation.js';
import { type ITreeViewsDnDService as ITreeViewsDnDServiceCommon, TreeViewsDnDService } from './treeViewsDnd.js';

export interface ITreeViewsDnDService extends ITreeViewsDnDServiceCommon<VSDataTransfer> {}

export const ITreeViewsDnDService = createServiceIdentifier<ITreeViewsDnDService>('treeViewsDndService');
registerSingleton(ITreeViewsDnDService, TreeViewsDnDService<VSDataTransfer>, InstantiationType.Delayed);

/** Registers the window-scoped tree drag transfer service. */
export function registerTreeViewsDnDService(container: ServiceContainer): void {
	container.registerSingleton(ITreeViewsDnDService, () => new TreeViewsDnDService<VSDataTransfer>());
}
