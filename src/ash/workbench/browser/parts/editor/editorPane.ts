import type { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import type { IEditorPane, IResourceEditorInput } from '../../../common/editor.js';
import { Composite } from '../../composite.js';
import type { IBulkEditOptions } from '../../../../editor/browser/services/bulkEditService.js';
import { addDisposableListener, getActiveElement, isHTMLElement, type IDimension } from '../../../../base/browser/dom.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { type ITextFileService } from '../../../services/textfile/common/textfiles.js';
import type { IFileService } from '../../../../platform/files/common/files.js';
import type { IDiffService } from '../../../services/diff/common/diffService.js';
import type { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import type { ICollabApi } from '../../../../platform/collab/common/collabApi.js';
import type { IServerEventApi } from '../../../../platform/agentHost/common/appServerApi.js';
import { type LanguageLocation, type LanguageWorkspaceEdit } from '../../../../editor/common/languages.js';
import type { ILanguageDiagnosticsService } from '../../../services/language/common/languageDiagnosticsService.js';
import type { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import type { IKeyboardLayoutService } from '../../../../platform/keyboardLayout/common/keyboardLayout.js';
import type { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import type { ContextKeyValue, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import type { IMenuService } from '../../../../platform/actions/common/actions.js';
import type { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import type { TextResourceLanguageResolver } from '../../../../platform/language/common/textResourceLanguage.js';
import type { IAction } from '../../../../base/common/actions.js';
import type { MenuId } from '../../../../platform/actions/common/actions.js';

/**
 * One editor implementation hosted by the central Editor Part.
 *
 * Implementations create their DOM exactly once in the supplied parent.
 * `setInput` may resolve asynchronously, must observe the abort signal, and
 * must reject when the input cannot be opened. The host owns the pane and
 * disposes it after hiding it.
 */
export abstract class EditorPane extends Composite implements IEditorPane {
	private editorToolbar: { readonly element: HTMLElement; readonly inlinePosition: Comment; } | undefined;
	private editorToolbarHost: HTMLElement | undefined;
	private editorToolbarVisible = false;

	/** Assigned by the group host before the pane creates its content. Modal panes have no document group. */
	public group: IEditorGroup | undefined;
	/** Pane-owned controls borrowed by modal or compact window chrome while this pane is active. */
	public getTitleControl(): HTMLElement | undefined { return undefined; }

	/** The group supplies a toolbar host before creating the pane and when the title visibility changes. */
	public setEditorToolbarHost(host: HTMLElement | undefined): void {
		if (host === this.editorToolbarHost) return;
		this.editorToolbarHost = host;
		this.placeEditorToolbar();
	}

	/** Mounts one toolbar for the pane's lifetime. The inline position is used by hosts without a title slot. */
	protected createEditorToolbar(element: HTMLElement, inlineParent: HTMLElement, before: Node | null = null): void {
		if (this.editorToolbar) throw new Error('The editor pane already has a toolbar');
		const inlinePosition = inlineParent.ownerDocument.createComment('editor toolbar');
		inlineParent.insertBefore(inlinePosition, before);
		this.editorToolbar = { element, inlinePosition };
		this._register(toDisposable(() => { element.remove(); inlinePosition.remove(); }));
		this.placeEditorToolbar();
		this.trackCompositeFocus(element);
	}

	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.editorToolbarVisible = visible;
		if (this.editorToolbar && this.editorToolbarHost) this.editorToolbar.element.hidden = !visible;
	}

	protected containsEditorElement(element: Node | null): boolean {
		return !!(this.getContainer()?.contains(element) || this.editorToolbar?.element.contains(element));
	}

	protected registerEditorKeydown(listener: (event: KeyboardEvent) => void, capture = false): void {
		const content = this.getContainer()!;
		this._register(addDisposableListener(content, 'keydown', listener, capture));
		const toolbar = this.editorToolbar?.element;
		if (toolbar) {
			this._register(addDisposableListener(toolbar, 'keydown', event => {
				if (!content.contains(toolbar)) listener(event);
			}, capture));
		}
	}

	protected bindEditorContextKey<T extends ContextKeyValue>(service: IContextKeyService, key: RawContextKey<T>, value: T): void {
		key.bindTo(this._register(service.createScoped(this.getContainer()!))).set(value);
		if (this.editorToolbar) key.bindTo(this._register(service.createScoped(this.editorToolbar.element))).set(value);
	}

	private placeEditorToolbar(): void {
		if (!this.editorToolbar) return;
		const { element, inlinePosition } = this.editorToolbar;
		const focused = getActiveElement(element.ownerDocument);
		const restoreFocus = isHTMLElement(focused) && element.contains(focused);
		element.hidden = !!this.editorToolbarHost && !this.editorToolbarVisible;
		if (this.editorToolbarHost) this.editorToolbarHost.append(element);
		else inlinePosition.after(element);
		if (restoreFocus && focused.isConnected) focused.focus({ preventScroll: true });
	}
	/** Lets a pane omit actions already hosted by its compact window title control. */
	public override getActions(_menuId?: MenuId): readonly IAction[] { return super.getActions(); }
	public abstract setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void>;
	public abstract clearInput(): void;
	public abstract layout(dimension: IDimension): void;
}

export interface EditorPane extends IEditorPane { }

export interface EditorPaneCreationOptions {
	/** The input used to choose a profile-specific pane implementation. */
	readonly input?: IResourceEditorInput;
	readonly configurationService?: IConfigurationService;
	readonly contextKeyService?: IContextKeyService;
	/** Group-scoped action services for pane-owned menus and toolbars. */
	readonly actionServices?: {
		readonly menuService: IMenuService;
		readonly contextMenuProvider: IContextMenuProvider;
		readonly contextKeyService?: IContextKeyService;
	};
	readonly keybindingService?: IKeybindingService;
	readonly keyboardLayoutService?: IKeyboardLayoutService;
	readonly fileService?: IFileService;
	readonly textFileService?: ITextFileService;
	readonly languageResolver?: TextResourceLanguageResolver;
	readonly diffService?: IDiffService;
	readonly instantiationService?: IInstantiationService;
	readonly accessibilityService?: IAccessibilityService;
	readonly languageDiagnosticsService?: ILanguageDiagnosticsService;
	readonly collabApi?: ICollabApi;
	readonly serverEvents?: IServerEventApi;
	readonly workingCopyService?: IWorkingCopyService;
	readonly onSave?: () => Promise<void | boolean>;
	readonly onOpenLocation?: (location: LanguageLocation) => void | Promise<void>;
	readonly onApplyWorkspaceEdit?: (edit: LanguageWorkspaceEdit, options?: IBulkEditOptions) => void | boolean | Promise<void | boolean>;
}

export enum EditorPaneMatch {
	None,
	/** Available for explicit requests and recovery actions. */
	ExplicitOnly,
	Optional,
	/** Product editor used when no resource-specific default matches. */
	Builtin,
	Default,
}
