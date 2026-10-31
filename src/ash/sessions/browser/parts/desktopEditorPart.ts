import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IUriIdentityService } from '../../../platform/uriIdentity/common/uriIdentity.js';
import type { IDimension } from '../../../base/browser/dom.js';
import type { IEditorGroupViewOptions } from '../../../workbench/browser/parts/editor/editor.js';
import type { IEditorPartOptions } from '../../../workbench/browser/parts/editor/editorPart.js';
import { DockedAuxiliaryBarController } from '../dockedAuxiliaryBarController.js';
import { Menus } from '../menus.js';
import { AuxiliaryBarPart } from './auxiliaryBarPart.js';
import { EditorPart } from './editorPart.js';
import './media/editorPart.css';

/** Owns the desktop document groups and their retained docked file tree. Changes has a separate host. */
export class DesktopMainEditorPart extends EditorPart {
	private auxiliary: AuxiliaryBarPart | undefined;
	private docking: DockedAuxiliaryBarController | undefined;

	constructor(
		container: HTMLElement,
		options: IEditorPartOptions,
		@IInstantiationService private readonly services: IInstantiationService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
		@IUriIdentityService identities: IUriIdentityService,
	) {
		super(container, options, services, theme, storage, identities);
		this._register(this.onDidLayout(() => this.docking?.layoutAuxiliaryBar()));
	}

	protected override getGroupViewOptions(): IEditorGroupViewOptions {
		return {
			showHeader: true,
			menuIds: {
				headerPrimary: Menus.SessionsEditorHeaderPrimary,
				headerLayout: Menus.SessionsEditorHeaderLayout,
				editorActions: Menus.SessionsEditorTitle,
			},
		};
	}

	public get auxiliaryBar(): AuxiliaryBarPart {
		return this.auxiliary ??= this._register(this.services.createInstance(AuxiliaryBarPart, this.domNode));
	}

	public get dockedAuxiliaryBar(): DockedAuxiliaryBarController {
		return this.docking ??= this._register(this.services.createInstance(DockedAuxiliaryBarController, this));
	}

	/** Docking calls the shared group layout; the Workbench still owns the outer card dimensions. */
	public layoutEditor(dimension: IDimension): void {
		super.layout(dimension);
	}

	protected override getFloatingBorderWidth(): number {
		return this.docking?.isMounted ? 0 : super.getFloatingBorderWidth();
	}
}
