import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IUriIdentityService } from '../../../platform/uriIdentity/common/uriIdentity.js';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { IViewDescriptorService, WorkbenchViewRegistry } from '../../../workbench/common/views.js';
import { ViewDescriptorService } from '../../../workbench/services/views/browser/viewDescriptorService.js';
import { Direction } from '../../../base/browser/ui/grid/grid.js';
import { computeScreenAwareSize, type IDimension } from '../../../base/browser/dom.js';
import { MutableDisposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import type { IResourceEditorInput, IEditorPane } from '../../../workbench/common/editor.js';
import type { IEditorGroupView, IEditorGroupViewOptions } from '../../../workbench/browser/parts/editor/editor.js';
import type { EditorGroupView } from '../../../workbench/browser/parts/editor/editorGroupView.js';
import type { IEditorPartOptions } from '../../../workbench/browser/parts/editor/editorPart.js';
import type { EditorOpenOptions, EditorOpenTarget } from '../../../workbench/services/editor/common/editorService.js';
import type { Part } from '../../../workbench/browser/part.js';
import { DockedAuxiliaryBarController } from '../dockedAuxiliaryBarController.js';
import { Menus } from '../menus.js';
import { EditorPart } from './editorPart.js';
import { DesktopAuxiliaryBarPart } from './desktopAuxiliaryBarPart.js';
import { EDITOR_PART_MINIMUM_WIDTH } from './editorPartSizing.js';
import './media/editorPart.css';

const DEFAULT_FILES_TREE_WIDTH = 300;
const MINIMUM_NARROW_EDITOR_WIDTH = 160;

/** Owns the main editor groups and the geometry of their docked details. */
export class DesktopMainEditorPart extends EditorPart {
	private readonly auxiliary = this._register(new MutableDisposable<DesktopAuxiliaryBarPart>());
	private inWorkingSet: (groupId: number) => boolean = () => true;
	private detailsDimension: IDimension = { width: 0, height: 0 };
	private detailsRequested = false;
	private showEditors = true;
	private hostVisible = true;
	private preferredDetailsWidth: number;
	private dockedAuxiliaryBar: DockedAuxiliaryBarController | undefined;
	private readonly productDock = this._register(new MutableDisposable());
	private productDetails: { readonly part: Part; readonly home: HTMLElement; readonly resize: (width: number) => void; } | undefined;
	private productDetailsWidth: number | undefined;
	private readonly detailsVisibility = this._register(new Emitter<void>());
	public readonly onDidChangeDetailsVisibility = this.detailsVisibility.event;

	constructor(
		container: HTMLElement,
		options: IEditorPartOptions,
		@IInstantiationService private readonly services: IInstantiationService,
		@IThemeService theme: IThemeService,
		@IStorageService private readonly storage: IStorageService,
		@IUriIdentityService identities: IUriIdentityService,
	) {
		super(container, { ...options, supportsGroupSplitting: false }, services, theme, storage, identities);
		this.domNode.classList.add('ash-code-editor-groups');
		this.groups.find(group => group.id === this.pageGroupId)!.domNode.classList.add('ash-code-page-group');
		const width = storage.getNumber('sessions.code.filesTreeWidth', StorageScope.PROFILE, DEFAULT_FILES_TREE_WIDTH);
		this.preferredDetailsWidth = Number.isFinite(width) && width >= 160 && width <= 800 ? width : DEFAULT_FILES_TREE_WIDTH;
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
			this._register(part.onDidRequestClose(() => this.hideDetails()));
			this.layoutDetails();
		}
		return this.auxiliary.value;
	}

	public setDockedAuxiliaryBar(details: typeof this.productDetails): void {
		if (this.productDetails?.part === details?.part) return;
		this.productDock.clear();
		this.productDetails = details;
		this.productDetailsWidth = undefined;
		if (details) this.productDock.value = this.getDockedAuxiliaryBar().dock(details.part, details.home);
		this.layoutDetails();
	}

	public layoutDockedAuxiliaryBar(width: number | undefined): void {
		this.productDetailsWidth = width;
		this.layoutDetails();
	}

	public get dockedAuxiliaryBarSize(): IDimension {
		return this.dockedAuxiliaryBar?.size ?? { width: 0, height: 0 };
	}

	private getDockedAuxiliaryBar(): DockedAuxiliaryBarController {
		return this.dockedAuxiliaryBar ??= this._register(new DockedAuxiliaryBarController(this.domNode, {
			getTabsHeight: () => this.getTabsHeight(),
			setEditorContentRightInset: width => this.setContentRightInset(width),
			setEditorContentVisible: visible => this.setEditorContentVisible(visible),
			setWidth: width => this.resizeDetails(width),
			commitWidth: width => {
				if (!this.productDetails) this.storage.store('sessions.code.filesTreeWidth', width, StorageScope.PROFILE, StorageTarget.MACHINE);
			},
			resetWidth: () => this.resizeDetails(this.productDetails ? this.productDetails.part.preferredWidth ?? DockedAuxiliaryBarController.MIN_WIDTH : DEFAULT_FILES_TREE_WIDTH),
		}));
	}

	private resizeDetails(width: number): void {
		if (this.productDetails) {
			this.productDetails.resize(Math.max(DockedAuxiliaryBarController.MIN_WIDTH, width));
		} else {
			this.preferredDetailsWidth = width;
			this.layoutDetails();
		}
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
		const changed = !this.detailsRequested;
		const part = this.auxiliaryBar;
		const composite = part.activeCompositeId ?? part.getCompositeIdToRestore();
		if (composite) part.showComposite(composite);
		this.detailsRequested = true;
		this.showEditors = this.fileGroups.some(group => !!group.activeInput);
		this.storage.store('sessions.code.filesVisible', true, StorageScope.PROFILE, StorageTarget.MACHINE);
		this.layoutDetails();
		if (changed) this.detailsVisibility.fire();
	}

	public hideDetails(): void {
		const changed = this.detailsRequested;
		this.detailsRequested = false;
		this.storage.store('sessions.code.filesVisible', false, StorageScope.PROFILE, StorageTarget.MACHINE);
		this.layoutDetails();
		if (changed) this.detailsVisibility.fire();
	}

	public setEditorVisible(visible: boolean): void {
		this.showEditors = visible;
		this.layoutDetails();
	}

	public async openFiles(): Promise<void> {
		const group = this.fileGroups.find(group => group === this.activeGroup) ?? this.fileGroups[0]
			?? this.insertGroup(this.activeGroup, Direction.Right).group;
		this.setGroupVisible(group.id, true);
		this.activateGroup(group.id);
		this.showDetails();
		this.auxiliaryBar.focus();
	}

	private layoutDetails(): void {
		// Working-set restoration temporarily detaches the entire group grid.
		if (this.isDisposed || this.groups.length === 0) return;
		const product = this.productDetails;
		const files = this.auxiliary.value;
		if (product) {
			files?.setVisible(false);
			const minimumWidth = DockedAuxiliaryBarController.MIN_WIDTH;
			this.getDockedAuxiliaryBar().layout(this.detailsDimension, {
				part: product.part,
				requestedWidth: this.hostVisible && this.isGroupVisible(this.pageGroupId) ? this.productDetailsWidth : undefined,
				minimumWidth,
				minimumEditorWidth: Math.min(EDITOR_PART_MINIMUM_WIDTH, Math.max(MINIMUM_NARROW_EDITOR_WIDTH, this.detailsDimension.width - minimumWidth)),
				editorVisible: true,
				hideWhenConstrained: true,
			});
		} else if (files || this.dockedAuxiliaryBar) {
			const minimumWidth = files?.minimumWidth ?? 0;
			const minimumEditorWidth = Math.min(EDITOR_PART_MINIMUM_WIDTH, Math.max(MINIMUM_NARROW_EDITOR_WIDTH, this.detailsDimension.width - minimumWidth));
			this.getDockedAuxiliaryBar().layout(this.detailsDimension, {
				part: files,
				requestedWidth: this.detailsVisible ? this.preferredDetailsWidth : undefined,
				minimumWidth,
				minimumEditorWidth,
				editorVisible: this.showEditors && this.fileGroups.some(group => !!group.activeInput),
				collapse: () => {
					// A collapse gesture leaves the last saved width available when Files is reopened.
					this.preferredDetailsWidth = this.storage.getNumber('sessions.code.filesTreeWidth', StorageScope.PROFILE, DEFAULT_FILES_TREE_WIDTH);
					this.hideDetails();
					this.activeGroup.focus();
				},
			});
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

	public resolveDefaultGroup(input: IResourceEditorInput) {
		const groups = this.fileGroups;
		const existing = groups.find(group => group.inputs.some(candidate => candidate.resource.toString() === input.resource.toString()));
		return existing ?? groups.find(group => group === this.activeGroup) ?? groups[0]
			?? this.insertGroup(this.activeGroup, Direction.Right).group;
	}

	public override async openEditor(input: IResourceEditorInput, options: EditorOpenOptions = {}, target?: EditorOpenTarget): Promise<IEditorPane> {
		if (target === undefined || target === 'sideGroup') {
			target = { groupId: this.resolveDefaultGroup(input).id };
		}
		if (typeof target === 'object' && !options.inactive) this.setGroupVisible(target.groupId, true);
		return super.openEditor(input, options, target);
	}
}
