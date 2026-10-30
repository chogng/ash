import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IUriIdentityService } from '../../../platform/uriIdentity/common/uriIdentity.js';
import { Direction } from '../../../base/browser/ui/grid/grid.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { EditorPart as WorkbenchEditorPart, type IEditorPartOptions } from '../../../workbench/browser/parts/editor/editorPart.js';
import { EDITOR_PART_MINIMUM_WIDTH } from './editorPartSizing.js';
import { localize } from '../../../nls.js';
import { h, type IDimension } from '../../../base/browser/dom.js';
import { Emitter } from '../../../base/common/event.js';
import type { IEditorPane, IResourceEditorInput } from '../../../workbench/common/editor.js';
import type { EditorOpenOptions, EditorOpenTarget } from '../../../workbench/services/editor/common/editorService.js';

/** Sessions keeps product pages alive independently of per-session document restoration. */
export class EditorPart extends WorkbenchEditorPart {
	public readonly pageGroupId: number;
	private cardPresentation = false;
	private readonly cardTitleDomNode: HTMLElement;
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
		this.titleDomNode.classList.add('ash-code-card-header');
		this.titleDomNode.hidden = true;
		this.cardTitleDomNode = h(container.ownerDocument, 'span', { className: 'ash-code-card-title' });
		this.titleDomNode.append(this.cardTitleDomNode);
		this.domNode.prepend(this.titleDomNode);
		// The retained page group participates in the same window-local ID allocator.
		const pages = this.insertGroup(this.activeGroup, Direction.Right).group;
		this.pageGroupId = pages.id;
		pages.setLocked(true);
		this.setGroupVisible(pages.id, false);
		this._register(this.onDidChangeEditors(() => this.updateCardTitle()));
		this.updateCardTitle();
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

	/** The Sessions card owns its header; the shared editor retains tabs, groups and documents. */
	public setCardPresentation(enabled: boolean): void {
		if (enabled === this.cardPresentation) { return; }
		this.cardPresentation = enabled;
		this.titleDomNode.hidden = !enabled;
		this.updateCardTitle();
		this.notifyConstraintsChanged();
	}

	private updateCardTitle(): void {
		let changesOnly = false;
		for (const group of this.groups) {
			if (group.id === this.pageGroupId) { continue; }
			const singleChanges = group.inputs.length === 1 && group.activeInput?.resource.scheme === 'ash-session-changes';
			// A lone Changes card already has a title and close action; document groups retain their tabs.
			group.setTitleVisible(!this.cardPresentation || !singleChanges);
			if (group === this.activeGroup) { changesOnly = singleChanges; }
		}
		const title = changesOnly ? localize('sessions.changes.title', 'Changes') : localize('sessions.cards.editor', 'Editor');
		this.cardTitleDomNode.textContent = title;
		this.cardTitleDomNode.title = title;
	}

	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.setEditorContentVisible(visible);
	}

	public override get minimumHeight(): number { return super.minimumHeight + (this.cardPresentation ? 36 : 0); }

	protected override layoutContents(width: number, height: number): { readonly contentSize: IDimension; } {
		return super.layoutContents(width, Math.max(0, height - (this.cardPresentation ? 36 : 0)));
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
