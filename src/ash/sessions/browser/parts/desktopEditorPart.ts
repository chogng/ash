import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IUriIdentityService } from '../../../platform/uriIdentity/common/uriIdentity.js';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { IViewDescriptorService, WorkbenchViewRegistry } from '../../../workbench/common/views.js';
import { ViewDescriptorService } from '../../../workbench/services/views/browser/viewDescriptorService.js';
import { Direction } from '../../../base/browser/ui/grid/grid.js';
import { Sash, SashState, Orientation } from '../../../base/browser/ui/sash/sash.js';
import { computeScreenAwareSize, type IDimension } from '../../../base/browser/dom.js';
import { MutableDisposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import type { IResourceEditorInput, IEditorPane } from '../../../workbench/common/editor.js';
import type { IEditorGroupView, IEditorGroupViewOptions } from '../../../workbench/browser/parts/editor/editor.js';
import type { EditorGroupView } from '../../../workbench/browser/parts/editor/editorGroupView.js';
import type { IEditorPartOptions } from '../../../workbench/browser/parts/editor/editorPart.js';
import { EditorHeaderControl } from '../../../workbench/browser/parts/editor/editorHeaderControl.js';
import type { EditorOpenOptions, EditorOpenTarget } from '../../../workbench/services/editor/common/editorService.js';
import { Menus } from '../menus.js';
import { EditorPart } from './editorPart.js';
import { DesktopAuxiliaryBarPart } from './desktopAuxiliaryBarPart.js';
import './media/editorPart.css';

/** Owns the Files editor grid and its contextual AuxiliaryBarPart as one desktop workspace. */
export class DesktopMainEditorPart extends EditorPart {
	private readonly auxiliary = this._register(new MutableDisposable<DesktopAuxiliaryBarPart>());
	private inWorkingSet: (groupId: number) => boolean = () => true;
	private detailsDimension: IDimension = { width: 0, height: 0 };
	private detailsRequested = false;
	private showEditors = true;
	private hostVisible = true;
	private preferredDetailsWidth: number;
	private detailsWidth = 0;
	private detailsSash: Sash | undefined;
	private layingOutDetails = false;

	constructor(
		container: HTMLElement,
		options: IEditorPartOptions,
		@IInstantiationService private readonly services: IInstantiationService,
		@IThemeService theme: IThemeService,
		@IStorageService private readonly storage: IStorageService,
		@IUriIdentityService identities: IUriIdentityService,
	) {
		super(container, options, services, theme, storage, identities);
		this.domNode.classList.add('ash-code-editor-groups');
		this.groups.find(group => group.id === this.pageGroupId)!.domNode.classList.add('ash-code-page-group');
		const width = storage.getNumber('sessions.code.filesTreeWidth', StorageScope.PROFILE, 220);
		this.preferredDetailsWidth = Number.isFinite(width) && width >= 160 && width <= 800 ? width : 220;
		storage.remove('sessions.code.filesGroup', StorageScope.WORKSPACE);
		this._register(this.onDidLayout(dimension => {
			this.detailsDimension = dimension;
			this.layoutDetails();
		}));
		this._register(this.onDidChangeEditors(event => {
			if (event.kind === 'groupChanged' && event.groupId !== this.pageGroupId && event.event.kind === 'activeEditorChanged') {
				this.showEditors = this.fileGroups.some(group => !!group.activeInput);
			}
			this.layoutDetails();
		}));
	}

	/** Contributions and the editor layout use the same lazily created Part instance. */
	public get auxiliaryBar(): DesktopAuxiliaryBarPart {
		if (!this.auxiliary.value) {
			const scope = this._register(this.services.createChild());
			// Commands belong to the contribution once per realm, rather than to each retained Part instance.
			const registry = this._register(new WorkbenchViewRegistry({ registerActions: false }));
			const descriptors = this._register(scope.createInstance(ViewDescriptorService, {
				registry, customizationsStorageKey: 'sessions.editorDetails.views',
			}));
			scope.registerInstance(IViewDescriptorService, descriptors);
			const container = this.domNode.ownerDocument.createElement('div');
			container.className = 'ash-editor-details-host';
			this.domNode.append(container);
			this._register(toDisposable(() => container.remove()));
			const context = this._register(this.services.get(IContextKeyService).createScoped(container));
			scope.registerInstance(IContextKeyService, context);
			const part = scope.createInstance(DesktopAuxiliaryBarPart, container, registry);
			this.auxiliary.value = part;
			this._register(part.onDidRequestVisibility(visible => visible ? this.showDetails() : this.hideDetails()));
			this.detailsSash = this._register(new Sash(this.domNode, {
				getVerticalSashLeft: () => this.detailsDimension.width - this.detailsWidth,
				getVerticalSashTop: () => EditorHeaderControl.HEIGHT,
				getVerticalSashHeight: () => Math.max(0, this.detailsDimension.height - EditorHeaderControl.HEIGHT),
			}, { orientation: Orientation.VERTICAL }));
			let startWidth = 0;
			this._register(this.detailsSash.onDidStart(() => { startWidth = this.detailsWidth; }));
			this._register(this.detailsSash.onDidChange(event => {
				this.preferredDetailsWidth = startWidth + event.startX - event.currentX;
				this.layoutDetails();
			}));
			this._register(this.detailsSash.onDidEnd(() => this.storage.store('sessions.code.filesTreeWidth', this.detailsWidth, StorageScope.PROFILE, StorageTarget.MACHINE)));
			this._register(this.detailsSash.onDidReset(() => { this.preferredDetailsWidth = 220; this.layoutDetails(); }));
			this.layoutDetails();
		}
		return this.auxiliary.value;
	}

	public get detailsOpen(): boolean { return this.detailsRequested; }
	public get detailsVisible(): boolean {
		return this.detailsRequested && this.hostVisible && !this.isGroupVisible(this.pageGroupId)
			&& this.fileGroups.some(group => this.isGroupVisible(group.id));
	}
	public get isEditorVisible(): boolean { return this.showEditors; }
	public get fileGroups(): readonly IEditorGroupView[] {
		return this.groups.filter(group => this.inWorkingSet(group.id) && group.id !== this.pageGroupId);
	}

	public setGroupScope(contains: (groupId: number) => boolean): IDisposable {
		this.inWorkingSet = contains;
		return toDisposable(() => { this.inWorkingSet = () => true; });
	}

	public showDetails(): void {
		const part = this.auxiliaryBar;
		const composite = part.activeCompositeId ?? part.getCompositeIdToRestore();
		if (composite) part.showComposite(composite);
		this.detailsRequested = true;
		this.showEditors = this.fileGroups.some(group => !!group.activeInput);
		this.storage.store('sessions.code.filesVisible', true, StorageScope.PROFILE, StorageTarget.MACHINE);
		this.layoutDetails();
	}

	public hideDetails(): void {
		this.detailsRequested = false;
		this.storage.store('sessions.code.filesVisible', false, StorageScope.PROFILE, StorageTarget.MACHINE);
		this.layoutDetails();
	}

	public setEditorVisible(visible: boolean): void {
		this.showEditors = visible;
		this.layoutDetails();
	}

	public async openFiles(): Promise<void> {
		const group = this.fileGroups.find(group => group === this.activeGroup) ?? this.fileGroups[0]
			?? this.addGroup(this.activeGroup.id, Direction.Right);
		this.setGroupVisible(group.id, true);
		this.activateGroup(group.id);
		this.showDetails();
		this.auxiliaryBar.focus();
	}

	private layoutDetails(): void {
		const part = this.auxiliary.value;
		// Working-set restoration temporarily detaches the entire group grid.
		if (!part || this.layingOutDetails || this.isDisposed || this.groups.length === 0) return;
		this.layingOutDetails = true;
		try {
			const visible = this.detailsVisible;
			const contentVisible = this.showEditors && this.fileGroups.some(group => !!group.activeInput);
			this.detailsWidth = !visible ? 0 : contentVisible
				? Math.min(Math.max(part.minimumWidth, this.preferredDetailsWidth), Math.max(0, this.detailsDimension.width - 160)) : this.detailsDimension.width;
			const height = Math.max(0, this.detailsDimension.height - EditorHeaderControl.HEIGHT);
			Object.assign(part.domNode.style, {
				top: EditorHeaderControl.HEIGHT + 'px', right: '0px', width: this.detailsWidth + 'px', height: height + 'px',
			});
			part.setVisible(visible);
			part.layout({ width: this.detailsWidth, height });
			this.setContentRightInset(this.detailsWidth);
			this.setEditorContentVisible(!visible || contentVisible);
			this.detailsSash!.state = visible && contentVisible ? SashState.Enabled : SashState.Disabled;
			this.detailsSash!.layout();
		} finally {
			this.layingOutDetails = false;
		}
	}

	protected override getGroupInsets(group: IEditorGroupView): number {
		return this.domNode.closest('.ash-desktop-editor-area') || group.id === this.pageGroupId ? 0 : computeScreenAwareSize(this.domNode.ownerDocument.defaultView!, 6);
	}

	protected override getFloatingBorderWidth(): number {
		return this.domNode.closest('.ash-desktop-editor-area') ? 0 : super.getFloatingBorderWidth();
	}

	protected override getGroupViewOptions(): IEditorGroupViewOptions {
		return {
			showHeader: true, menuIds: {
				headerPrimary: Menus.SessionsEditorHeaderPrimary,
				headerLayout: Menus.SessionsEditorHeaderLayout,
				editorActions: Menus.SessionsEditorTitle,
			}
		};
	}

	protected override removeEmptyGroup(group: EditorGroupView): void {
		if (this.detailsOpen && this.fileGroups.length === 1 && this.fileGroups[0] === group) return;
		super.removeEmptyGroup(group);
	}

	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.hostVisible = visible;
		this.layoutDetails();
	}

	public override async openEditor(input: IResourceEditorInput, options: EditorOpenOptions = {}, target?: EditorOpenTarget): Promise<IEditorPane> {
		if (target === undefined) {
			const groups = this.fileGroups;
			const existing = groups.find(group => group.inputs.some(candidate => candidate.resource.toString() === input.resource.toString()));
			const group = existing ?? groups.find(group => group === this.activeGroup) ?? groups[0]
				?? this.addGroup(this.activeGroup.id, Direction.Right);
			target = { groupId: group.id };
		}
		if (typeof target === 'object' && !options.inactive) this.setGroupVisible(target.groupId, true);
		return super.openEditor(input, options, target);
	}
}
