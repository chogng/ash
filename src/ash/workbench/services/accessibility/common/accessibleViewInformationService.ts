import { Disposable } from "../../../../base/common/lifecycle.js";
import { ACCESSIBLE_VIEW_SHOWN_STORAGE_PREFIX } from "../../../../platform/accessibility/common/accessibility.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import { IStorageService, StorageScope } from "../../../../platform/storage/common/storage.js";

/** Stores application-scoped accessible-view visibility history. */
export interface IAccessibleViewInformationService {
	hasShownAccessibleView(viewId: string): boolean;
}

export const IAccessibleViewInformationService = createServiceIdentifier<IAccessibleViewInformationService>("accessibleViewInformationService");

/** Reads durable accessible-view history without owning accessible-view UI. */
export class AccessibleViewInformationService extends Disposable implements IAccessibleViewInformationService {
	constructor(private readonly storageService: IStorageService) {
		super();
	}

	hasShownAccessibleView(viewId: string): boolean {
		return this.storageService.getBoolean(`${ACCESSIBLE_VIEW_SHOWN_STORAGE_PREFIX}${viewId}`, StorageScope.APPLICATION, false) === true;
	}
}
