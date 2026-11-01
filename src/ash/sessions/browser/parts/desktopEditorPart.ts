import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IUriIdentityService } from '../../../platform/uriIdentity/common/uriIdentity.js';
import { Direction } from '../../../base/browser/ui/grid/grid.js';
import { BrowserViewUri } from '../../../platform/browserView/common/browserViewUri.js';
import { TerminalEditorInput } from '../../../workbench/contrib/terminal/browser/terminalEditorInput.js';
import { toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import type { IResourceEditorInput, IEditorPane } from '../../../workbench/common/editor.js';
import type { IEditorGroupView, IEditorGroupViewOptions } from '../../../workbench/browser/parts/editor/editor.js';
import type { EditorGroupView } from '../../../workbench/browser/parts/editor/editorGroupView.js';
import type { IEditorPartOptions } from '../../../workbench/browser/parts/editor/editorPart.js';
import type { EditorOpenOptions, EditorOpenTarget } from '../../../workbench/services/editor/common/editorService.js';
import { DockedAuxiliaryBarController } from '../dockedAuxiliaryBarController.js';
import { Menus } from '../menus.js';
import { EditorPart } from './editorPart.js';
import './media/editorPart.css';

/** One editor host owns Code's files, reviews, browser pages and terminal inputs. */
export class DesktopMainEditorPart extends EditorPart {
	private navigation: DockedAuxiliaryBarController | undefined;
	private inWorkingSet: (groupId: number) => boolean = () => true;

	/** The session controller supplies scope from its existing live-group bindings. */
	public setGroupScope(contains: (groupId: number) => boolean): IDisposable {
		this.inWorkingSet = contains;
		return toDisposable(() => { this.inWorkingSet = () => true; });
	}

	constructor(
		container: HTMLElement,
		options: IEditorPartOptions,
		@IInstantiationService private readonly services: IInstantiationService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
		@IUriIdentityService identities: IUriIdentityService,
	) { super(container, options, services, theme, storage, identities); }

	protected override getGroupViewOptions(): IEditorGroupViewOptions {
		return {
			showHeader: true, menuIds: {
				headerPrimary: Menus.SessionsEditorHeaderPrimary,
				headerLayout: Menus.SessionsEditorHeaderLayout,
				editorActions: Menus.SessionsEditorTitle,
			}
		};
	}

	public get fileNavigation(): DockedAuxiliaryBarController {
		return this.navigation ??= this._register(this.services.createInstance(DockedAuxiliaryBarController, this));
	}
	public get filesVisible(): boolean { return this.navigation?.visible === true; }
	public get filesNavigationVisible(): boolean { return this.navigation?.isVisible === true; }
	public get fileEditorsVisible(): boolean {
		return this.groups.some(group => this.inWorkingSet(group.id) && group.id !== this.pageGroupId && this.isGroupVisible(group.id)
			&& (!group.activeInput || this.isFileEditor(group.activeInput)));
	}
	public get filesView() { return this.navigation?.view; }

	public isFileEditor(input: IResourceEditorInput): boolean {
		return input.resource.scheme !== 'ash-session-changes' && input.resource.scheme !== BrowserViewUri.scheme && !(input instanceof TerminalEditorInput);
	}

	public toggleFileEditors(): Promise<boolean> {
		return this.toggleToolEditors(input => this.isFileEditor(input), { emptyGroupId: this.navigation?.groupId, allGroups: true });
	}

	protected override removeEmptyGroup(group: EditorGroupView): void {
		// Files navigation is retained group content even when no document is open.
		if (this.navigation?.visible && this.navigation.groupId === group.id) return;
		super.removeEmptyGroup(group);
	}

	public async openFiles(): Promise<void> {
		const navigation = this.fileNavigation;
		const fileGroups = this.groups.filter(group => this.inWorkingSet(group.id) && group.id !== this.pageGroupId
			&& (group.inputs.length === 0 || group.inputs.some(input => this.isFileEditor(input))));
		const group = fileGroups.find(group => group.id === navigation.groupId)
			?? fileGroups.find(group => group === this.activeGroup) ?? fileGroups[0]
			?? this.addGroup(this.activeGroup.id, Direction.Right);
		this.setGroupVisible(group.id, true);
		this.activateGroup(group.id);
		navigation.show(group as EditorGroupView);
		navigation.focus();
	}

	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.navigation?.setVisible(visible);
	}

	public override async openEditor(input: IResourceEditorInput, options: EditorOpenOptions = {}, target?: EditorOpenTarget): Promise<IEditorPane> {
		const existing = this.groups.find(group => this.inWorkingSet(group.id) && group.inputs.some(candidate => candidate.resource.toString() === input.resource.toString()));
		if (target === undefined && !options.inactive && this.isFileEditor(input)) {
			const active = this.inWorkingSet(this.activeGroup.id) && this.activeGroup.activeInput && this.isFileEditor(this.activeGroup.activeInput) ? this.activeGroup : undefined;
			const group = existing ?? active ?? this.groups.find(group => this.inWorkingSet(group.id) && group.id !== this.pageGroupId
				&& (group.id === this.navigation?.groupId || group.inputs.some(candidate => this.isFileEditor(candidate))));
			if (group) target = { groupId: group.id };
			else if (this.activeGroup.inputs.length > 0) target = { groupId: this.addGroup(this.activeGroup.id, Direction.Right).id };
		}
		if (target === undefined && !this.isGroupVisible(this.activeGroup.id)) {
			const visible = this.groups.find(group => this.inWorkingSet(group.id) && this.isGroupVisible(group.id));
			if (visible) this.activateGroup(visible.id);
			else this.setGroupVisible(this.activeGroup.id, true);
		}
		if (existing && !options.inactive) this.setGroupVisible(existing.id, true);
		// Initial tool opens split the current group. Once placed, normal editor routing
		// respects the user's group, including groups containing different kinds of tabs.
		if (target === undefined && !existing && !options.inactive && this.activeGroup.inputs.length > 0 &&
			!this.isFileEditor(input)) {
			target = { groupId: this.addGroup(this.activeGroup.id, Direction.Down).id };
		}
		return super.openEditor(input, options, target ?? { groupId: existing?.id ?? this.activeGroup.id });
	}

	/** Queries the current session's tools, including retained hidden groups. */
	public getToolGroups(accepts: (input: IResourceEditorInput) => boolean, options: { readonly emptyGroupId?: number; } = {}): readonly IEditorGroupView[] {
		return this.groups.filter(group => this.inWorkingSet(group.id)
			&& (group.inputs.some(accepts) || (group.inputs.length === 0 && group.id === options.emptyGroupId)));
	}

	/** Hiding tools retains their inputs; a mixed group selects its next non-tool tab. */
	public async toggleToolEditors(accepts: (input: IResourceEditorInput) => boolean, options: { readonly emptyGroupId?: number; readonly allGroups?: boolean; } = {}): Promise<boolean> {
		const groups = this.getToolGroups(accepts, options);
		if (groups.length === 0) return false;
		const visible = groups.some(group => this.isGroupVisible(group.id) && (!group.activeInput || accepts(group.activeInput)));
		for (const group of groups) {
			if (visible) {
				if (group.activeInput && !accepts(group.activeInput)) continue;
				const other = group.inputs.find(input => !accepts(input));
				if (other) group.activateEditor(other);
				else this.setGroupVisible(group.id, false);
			} else {
				this.setGroupVisible(group.id, true);
				const input = group.inputs.find(accepts);
				if (input) await this.openEditor(input, { pinned: true }, { groupId: group.id });
				this.focus();
				if (!options.allGroups) break;
			}
		}
		return true;
	}
}
