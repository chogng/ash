import './media/emptyFileEditor.css';
import { h } from '../../../../base/browser/dom.js';
import { ButtonActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { ActionRunner } from '../../../../base/common/actions.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import type { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { MenuWorkbenchToolBar, type IMenuWorkbenchToolBarOptions } from '../../../../platform/actions/browser/toolbar.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { EmptyFileEditorInput } from '../../../../workbench/contrib/sessions/browser/emptyFileEditorInput.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { Menus } from '../../../browser/menus.js';
import { EmptyFileEditorSearch } from './emptyFileEditorSearch.js';

export const EmptyFileEditorFocusedContext = new RawContextKey<boolean>('emptyFileEditorFocused', false);

/** Files tab shown before a document is opened. */
export class EmptyFileEditor extends EditorPane {
	static readonly ID = EmptyFileEditorInput.EDITOR_ID;
	readonly id = EmptyFileEditor.ID;
	private search: EmptyFileEditorSearch | undefined;

	constructor(
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IEditorService private readonly editors: IEditorService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super(EmptyFileEditor.ID, theme, storage);
	}

	override create(parent: HTMLElement): void {
		super.create(parent);
		const document = parent.ownerDocument;
		const surface = h(document, 'div', { className: 'ash-empty-file-editor' });
		const content = h(document, 'div', { className: 'ash-empty-file-editor-content' });
		const searchContainer = h(document, 'div', { className: 'ash-empty-file-editor-search' });
		const actions = h(document, 'div', { className: 'ash-empty-file-editor-actions' });
		content.append(searchContainer, actions);
		surface.append(content);
		parent.append(surface);
		const contextKeys = this._register(this.contextKeys.createScoped(surface));
		EmptyFileEditorFocusedContext.bindTo(contextKeys).set(true);
		this.search = this._register(this.instantiation.createInstance(EmptyFileEditorSearch, searchContainer, {
			isVisible: () => this.isVisible(),
			openFile: (resource: URI) => this.group
				? this.editors.openEditor({ resource }, { pinned: true }, { groupId: this.group.id })
				: Promise.resolve(),
		}));
		const runner = this._register(new ActionRunner());
		this._register(runner.onDidRun(({ error }) => {
			if (error && !isCancellationError(error)) this.notifications.error(error instanceof Error ? error : String(error));
		}));
		this._register(this.instantiation.createInstance(MenuWorkbenchToolBar, actions, Menus.EmptyFileEditorActions, {
			ariaLabel: localize('sessions.files.title', 'Files'),
			contextKeyService: contextKeys,
			menuOptions: { arg: this },
			actionRunner: runner,
			orientation: 'vertical',
			actionViewItemProvider: (action, options) => new ButtonActionViewItem(action, { ...options, iconOnly: false }),
		} satisfies IMenuWorkbenchToolBarOptions));
	}

	openFile(): void { this.search?.show(); }
	override focus(): void { this.search?.focus(); }
	override clearInput(): void { this.search?.clear(); }
	override layout(): void { }
	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (!visible) this.search?.clear();
	}

	override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (!(input instanceof EmptyFileEditorInput)) { throw new TypeError('Invalid Files editor input'); }
	}
}
