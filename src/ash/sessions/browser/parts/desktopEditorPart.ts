import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IUriIdentityService } from '../../../platform/uriIdentity/common/uriIdentity.js';
import { Direction } from '../../../base/browser/ui/grid/grid.js';
import { BrowserViewUri } from '../../../platform/browserView/common/browserViewUri.js';
import { TerminalEditorInput } from '../../../workbench/contrib/terminal/browser/terminalEditorInput.js';
import { toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import type { IResourceEditorInput, IEditorPane } from '../../../workbench/common/editor.js';
import type { IEditorGroupViewOptions } from '../../../workbench/browser/parts/editor/editor.js';
import type { EditorGroupView } from '../../../workbench/browser/parts/editor/editorGroupView.js';
import type { IEditorPartOptions } from '../../../workbench/browser/parts/editor/editorPart.js';
import type { EditorOpenOptions, EditorOpenTarget } from '../../../workbench/services/editor/common/editorService.js';
import { DockedAuxiliaryBarController } from '../dockedAuxiliaryBarController.js';
import { EmptyFileEditorInput } from '../../contrib/editor/browser/emptyFileEditorInput.js';
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
	public get filesView() { return this.navigation?.view; }

	public async openFiles(): Promise<void> {
		const navigation = this.fileNavigation;
		const group = this.groups.find(group => group.id === navigation.groupId && this.inWorkingSet(group.id))
			?? (this.inWorkingSet(this.activeGroup.id) ? this.activeGroup : this.groups.find(group => this.inWorkingSet(group.id))!);
		this.setGroupVisible(group.id, true);
		this.activateGroup(group.id);
		if (!group.activeInput) await this.openEditor(new EmptyFileEditorInput(), { pinned: true }, { groupId: group.id });
		navigation.show(group as EditorGroupView);
		navigation.focus();
	}

	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.navigation?.setVisible(visible);
	}

	public override async openEditor(input: IResourceEditorInput, options: EditorOpenOptions = {}, target?: EditorOpenTarget): Promise<IEditorPane> {
		if (target === undefined && !this.isGroupVisible(this.activeGroup.id)) {
			const visible = this.groups.find(group => this.inWorkingSet(group.id) && this.isGroupVisible(group.id));
			if (visible) this.activateGroup(visible.id);
			else this.setGroupVisible(this.activeGroup.id, true);
		}
		const existing = this.groups.find(group => this.inWorkingSet(group.id) && group.inputs.some(candidate => candidate.resource.toString() === input.resource.toString()));
		if (existing && !options.inactive) this.setGroupVisible(existing.id, true);
		// Initial tool opens split the current group. Once placed, normal editor routing
		// respects the user's group, including groups containing different kinds of tabs.
		if (target === undefined && !existing && !options.inactive && this.activeGroup.inputs.length > 0 &&
			(input.resource.scheme === 'ash-session-changes' || input.resource.scheme === BrowserViewUri.scheme || input instanceof TerminalEditorInput)) {
			target = { groupId: this.addGroup(this.activeGroup.id, Direction.Down).id };
		}
		return super.openEditor(input, options, target ?? { groupId: existing?.id ?? this.activeGroup.id });
	}

	/** Hiding tools retains their inputs; a mixed group selects its next non-tool tab. */
	public async toggleToolEditors(accepts: (input: IResourceEditorInput) => boolean): Promise<boolean> {
		const groups = this.groups.filter(group => this.inWorkingSet(group.id) && group.inputs.some(accepts));
		if (groups.length === 0) return false;
		const visible = groups.some(group => this.isGroupVisible(group.id) && !!group.activeInput && accepts(group.activeInput));
		for (const group of groups) {
			if (visible) {
				if (!group.activeInput || !accepts(group.activeInput)) continue;
				const other = group.inputs.find(input => !accepts(input));
				if (other) group.activateEditor(other);
				else this.setGroupVisible(group.id, false);
			} else {
				this.setGroupVisible(group.id, true);
				await this.openEditor(group.inputs.find(accepts)!, { pinned: true }, { groupId: group.id });
				this.focus();
				break;
			}
		}
		return true;
	}
}
