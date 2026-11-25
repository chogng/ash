import { Event } from '../../../base/common/event.js';
import { IAccessibilityService } from '../../../platform/accessibility/common/accessibility.js';
import { createTestMenuToolbarServices } from '../../../platform/actions/test/browser/testMenuToolbarServices.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { ILabelService } from '../../../platform/label/common/label.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { TestWorkspaceService } from '../../../workbench/services/configuration/test/common/testServices.js';
import { LabelService } from '../../../workbench/services/label/common/labelService.js';
import { createTestPathService, testAppServerApi } from '../../../workbench/test/common/workbenchHostTestServices.js';
import { SessionsList } from '../../contrib/sessions/browser/views/sessionsList.js';

export class TestSessionsList extends SessionsList {
	constructor(...args: ConstructorParameters<typeof SessionsList>) {
		const parent = args[23];
		const services = createTestMenuToolbarServices(args[12], args[10], parent instanceof InstantiationService ? parent : undefined);
		if (!services.has(IAccessibilityService)) {
			services.registerInstance(IAccessibilityService, { onDidChangeReducedMotion: Event.None, isMotionReduced: () => true } as IAccessibilityService);
		}
		args[23] = services;
		try {
			if (!services.has(ILabelService)) {
				if (!services.has(IWorkspaceContextService)) {
					services.registerSingleton(IWorkspaceContextService, () => new TestWorkspaceService({ id: 'test-sessions-list', folders: [] }));
				}
				services.registerSingleton(ILabelService, () => {
					const workspace = services.get(IWorkspaceContextService);
					return new LabelService(workspace, createTestPathService({}, workspace), testAppServerApi({}));
				});
			}
			super(...args);
		} catch (error) {
			services.dispose();
			throw error;
		}
		this._register(services);
	}
}
