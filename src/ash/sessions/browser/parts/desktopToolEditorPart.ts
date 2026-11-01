import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IUriIdentityService } from '../../../platform/uriIdentity/common/uriIdentity.js';
import { Direction } from '../../../base/browser/ui/grid/grid.js';
import { EditorPart, type IEditorPartOptions } from '../../../workbench/browser/parts/editor/editorPart.js';
import type { IEditorGroupViewOptions } from '../../../workbench/browser/parts/editor/editor.js';
import type { IResourceEditorInput, IEditorPane } from '../../../workbench/common/editor.js';
import type { EditorOpenOptions, EditorOpenTarget } from '../../../workbench/services/editor/common/editorService.js';
import { Menus } from '../menus.js';

/** A normal editor host reused for independent tool workspaces; tool models stay in their services. */
export class DesktopToolEditorPart extends EditorPart {
	private inWorkingSet: (id: number) => boolean = () => true;
	constructor(
		container: HTMLElement,
		options: IEditorPartOptions,
		@IInstantiationService services: IInstantiationService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
		@IUriIdentityService identities: IUriIdentityService,
	) {
		super(container, options, services, theme, storage, identities);
	}

	public setGroupScope(contains: (id: number) => boolean): void { this.inWorkingSet = contains; }
	protected override getFloatingBorderWidth(): number { return 0; }
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
	public override async openEditor(input: IResourceEditorInput, options: EditorOpenOptions = {}, target?: EditorOpenTarget): Promise<IEditorPane> {
		if (!target) {
			const groups = this.groups.filter(group => this.inWorkingSet(group.id));
			const group = groups.find(group => group.inputs.some(candidate => candidate.resource.toString() === input.resource.toString()))
				?? groups.find(group => group === this.activeGroup) ?? groups[0] ?? this.addGroup(this.activeGroup.id, Direction.Right);
			target = { groupId: group.id };
		}
		if (typeof target === 'object' && !options.inactive) { this.setGroupVisible(target.groupId, true); }
		return super.openEditor(input, options, target);
	}
}
