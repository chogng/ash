import './media/emptyFileEditor.css';
import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { EmptyFileEditorInput } from '../../../../workbench/contrib/sessions/browser/emptyFileEditorInput.js';
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
		@INotificationService private readonly notifications: INotificationService,
		@IMenuService private readonly menus: IMenuService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
	) {
		super(EmptyFileEditor.ID, theme, storage);
	}

	override create(parent: HTMLElement): void {
		super.create(parent);
		const document = parent.ownerDocument;
		const surface = h(document, 'div', { className: 'ash-empty-file-editor' });
		const content = h(document, 'div', { className: 'ash-empty-file-editor-content' });
		surface.append(content);
		parent.append(surface);
		const contextKeys = this._register(this.contextKeys.createScoped(surface));
		EmptyFileEditorFocusedContext.bindTo(contextKeys).set(true);
		this.search = this._register(this.instantiation.createInstance(EmptyFileEditorSearch, content, this));

		const shortcutsLabel = localize('sessions.emptyFileEditor.actions', 'Open');
		const shortcuts = h(document, 'section', { className: 'ash-empty-file-editor-shortcuts', attributes: { 'aria-label': shortcutsLabel } });
		const actions = h(document, 'div', { className: 'ash-empty-file-editor-actions' });
		shortcuts.append(h(document, 'h2', {}, shortcutsLabel), actions);
		content.append(shortcuts);

		const menu = this._register(this.menus.createMenu(Menus.EmptyFileEditorActions, contextKeys));
		const buttons = this._register(new DisposableStore());
		const renderActions = () => {
			buttons.clear();
			actions.replaceChildren();
			for (const [, items] of menu.getActions({ arg: this })) {
				for (const action of items) {
					buttons.add(new Button(actions, {
						...defaultButtonStyles,
						label: action.label, icon: action.icon, enabled: action.enabled, presentation: 'secondary',
						onClick: () => { void Promise.resolve().then(() => action.run()).catch(error => this.notifications.error(error)); },
					}));
				}
			}
			shortcuts.hidden = actions.childElementCount === 0;
		};
		this._register(menu.onDidChange(renderActions));
		renderActions();
	}

	openFile(): void { this.search?.show(); }
	override focus(): void { this.search?.focus(); }
	override clearInput(): void { this.search?.clear(); }
	override layout(): void { }

	override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (!(input instanceof EmptyFileEditorInput)) { throw new TypeError('Invalid Files editor input'); }
	}
}
