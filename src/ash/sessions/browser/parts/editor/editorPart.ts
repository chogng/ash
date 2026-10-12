import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { Direction } from '../../../../base/browser/ui/grid/grid.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorPart as WorkbenchEditorPart, type IEditorPartOptions } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { EDITOR_PART_MINIMUM_WIDTH } from './editorPartSizing.js';

/** Sessions keeps product pages alive independently of per-session document restoration. */
export class EditorPart extends WorkbenchEditorPart {
	public readonly pageGroupId: string;

	constructor(
		container: HTMLElement,
		options: IEditorPartOptions,
		@IInstantiationService instantiation: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IUriIdentityService uriIdentity: IUriIdentityService,
	) {
		super(container, options, instantiation, themeService, storageService, uriIdentity);
		// A separate identity cannot collide with document group IDs restored from an older session.
		const pages = this.insertGroup(this.activeGroup, Direction.Right, 'sessions-product-pages').group;
		this.pageGroupId = pages.id;
		pages.setLocked(true);
		this.setGroupVisible(pages.id, false);
		this._register(this.onDidChangeEditors(event => {
			if (this.isDisposed || event.kind !== 'groupRemoved' || this.groups.length !== 1 || this.groups[0]!.id !== this.pageGroupId) { return; }
			// Working-set restoration temporarily detaches every group. Recreate a document host only
			// when the retained product group is actually the sole live group after a close.
			const documents = this.addGroup(this.pageGroupId, Direction.Left);
			const productVisible = this.isGroupVisible(this.pageGroupId);
			this.setGroupVisible(documents.id, !productVisible);
			if (!productVisible) { this.activateGroup(documents.id); }
		}));
	}

	public override get minimumWidth(): number { return Math.max(EDITOR_PART_MINIMUM_WIDTH, super.minimumWidth); }
}
