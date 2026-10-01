import '../../../../workbench/contrib/files/browser/files.contribution.js';
import '../../../../workbench/contrib/files/browser/media/explorerviewlet.css';
import { ServiceConstructionDescriptor } from '../../../../platform/instantiation/common/instantiation.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { ViewContainerLocation } from '../../../../workbench/common/views.js';
import { SessionsViewRegistry } from '../../../common/views.js';
import { ExplorerView } from '../../../../workbench/contrib/files/browser/views/explorerView.js';
import { VIEW_ID } from '../../../../workbench/contrib/files/common/files.js';

export const SESSIONS_FILES_CONTAINER_ID = 'workbench.sessions.auxiliaryBar.filesContainer';

SessionsViewRegistry.registerStaticViewContainer({
	id: SESSIONS_FILES_CONTAINER_ID,
	title: 'Files',
	localizationKey: { bundle: 'ash', key: 'sessions.files.title' },
	location: ViewContainerLocation.AuxiliaryBar,
	icon: Lxicon.files,
	order: 0,
	isDefault: true,
});
SessionsViewRegistry.registerStaticViews(SESSIONS_FILES_CONTAINER_ID, [{
	id: VIEW_ID,
	title: 'Files',
	localizationKey: { bundle: 'ash', key: 'sessions.files.title' },
	ctorDescriptor: new ServiceConstructionDescriptor(ExplorerView),
	canToggleVisibility: false,
}]);
