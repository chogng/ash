import { IViewsService } from '../../../../../workbench/services/views/common/viewsService.js';
import { SESSIONS_FILES_CONTAINER_ID } from '../../../files/browser/files.contribution.js';
import { CHANGES_VIEW_CONTAINER_ID } from '../../../changes/common/changes.js';

/** Tool selection is explicit; opening or closing a document never hides Files. */
export class DesktopDetailPanelCoordinator {
	constructor(@IViewsService private readonly views: IViewsService) { }

	public get supportsActiveEditor(): boolean {
		return true;
	}

	public async update(reveal: boolean): Promise<void> {
		if (reveal || this.views.isViewContainerActive(CHANGES_VIEW_CONTAINER_ID)) await this.openFiles();
	}

	public async openFiles(): Promise<void> {
		await this.views.openViewContainer(SESSIONS_FILES_CONTAINER_ID);
	}

}
