import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { Direction } from '../../../../base/browser/ui/grid/grid.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorPart as WorkbenchEditorPart, type IEditorPartOptions } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { EDITOR_PART_MINIMUM_WIDTH } from './editorPartSizing.js';
import { Emitter } from '../../../../base/common/event.js';
import type { IEditorPane, IResourceEditorInput } from '../../../../workbench/common/editor.js';
import type { EditorOpenOptions, EditorOpenTarget } from '../../../../workbench/services/editor/common/editorService.js';

/** Sessions keeps product pages alive independently of per-session document restoration. */
export class EditorPart extends WorkbenchEditorPart {
	public readonly pageGroupId: number;
	private readonly revealActiveEditor = this._register(new Emitter<void>());
	public readonly onDidRevealActiveEditor = this.revealActiveEditor.event;

	constructor(
		container: HTMLElement,
		options: IEditorPartOptions,
		@IInstantiationService instantiation: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IUriIdentityService uriIdentity: IUriIdentityService,
	) {
		super(container, options, instantiation, themeService, storageService, uriIdentity);
		// The retained page group participates in the same window-local ID allocator.
		const pages = this.insertGroup(this.activeGroup, Direction.Right).group;
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

	public override async openEditor(input: IResourceEditorInput, options: EditorOpenOptions = {}, target?: EditorOpenTarget): Promise<IEditorPane> {
		const previous = this.activePane;
		const pane = await super.openEditor(input, options, target);
		// Reopening the same tab emits no active-editor change. Sessions may have
		// hidden its editor area meanwhile, so its layout owner still needs to reveal it.
		if (pane === previous && pane === this.activePane && !options.inactive && !options.preserveFocus && !this.isModalEditorVisible) {
			this.revealActiveEditor.fire();
		}
		return pane;
	}
}
