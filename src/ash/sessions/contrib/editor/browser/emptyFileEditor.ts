import './media/emptyFileEditor.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { normalizeBrowserViewUrl } from '../../../../platform/browserView/common/browserView.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { EditorPane, EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { EditorInputSerializers, requireRecord } from '../../../../workbench/services/editor/common/editorInputSerializer.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { Menus } from '../../../browser/menus.js';

export const EditorStartBrowserCommand = 'ash.sessions.newBrowserTab';

export class EditorStartInput extends EditorInput {
	static readonly SCHEME = 'ash-sessions-new-tab';
	static readonly ID = 'sessions.editorInput.newTab';
	readonly typeId = EditorStartInput.ID;
	readonly resource = URI.from({ scheme: EditorStartInput.SCHEME, path: '/new-tab' });
	readonly onDidChangeLabel = undefined;
	readonly readOnly = true;
	readonly showBreadcrumbs = false;

	getName(): string { return localize('sessions.editorStart.newTab', 'New Tab'); }
	getIcon() { return Lxicon.add; }
}

/** Shows workspace entry points in an ordinary editor tab. */
class EmptyFileEditor extends EditorPane {
	static readonly ID = 'ash.sessions.editorStart';
	readonly id = EmptyFileEditor.ID;
	private input: InputBox | undefined;

	constructor(
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IEditorService private readonly editors: IEditorService,
		@ICommandService private readonly commands: ICommandService,
		@IOpenerService private readonly opener: IOpenerService,
		@INotificationService private readonly notifications: INotificationService,
		@IMenuService private readonly menus: IMenuService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
	) {
		super(EmptyFileEditor.ID, theme, storage);
	}

	override create(parent: HTMLElement): void {
		super.create(parent);
		const document = parent.ownerDocument;
		const surface = h(document, 'div', { className: 'ash-editor-start' });
		const content = h(document, 'div', { className: 'ash-editor-start-content' });
		const search = h(document, 'form', { className: 'ash-editor-start-search' });
		const searchLabel = localize('sessions.editorStart.searchOrUrl', 'Search files or enter a URL');
		const input = this.input = this._register(new InputBox(search, {
			inputBoxStyles: defaultInputBoxStyles, presentation: 'field', ariaLabel: searchLabel, placeholder: searchLabel,
		}));
		this._register(new Button(search, {
			...defaultButtonStyles,
			label: localize('sessions.editorStart.go', 'Go'),
			icon: Lxicon.arrowRight, iconOnly: true, type: 'submit', presentation: 'secondary',
		}));
		this._register(addDisposableListener(search, 'submit', event => {
			event.preventDefault();
			void this.submit(input.value.trim()).catch(error => this.notifications.error(error));
		}));

		const shortcutsLabel = localize('sessions.editorStart.actions', 'Open');
		const shortcuts = h(document, 'section', { className: 'ash-editor-start-shortcuts', attributes: { 'aria-label': shortcutsLabel } });
		const actions = h(document, 'div', { className: 'ash-editor-start-actions' });
		shortcuts.append(h(document, 'h2', {}, shortcutsLabel), actions);
		content.append(search, shortcuts);
		surface.append(content);
		parent.append(surface);

		const menu = this._register(this.menus.createMenu(Menus.SessionsEditorStart, this.contextKeys));
		const buttons = this._register(new DisposableStore());
		const renderActions = () => {
			buttons.clear();
			actions.replaceChildren();
			for (const [, items] of menu.getActions()) {
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

	private async submit(value: string): Promise<void> {
		if (/^(?:https?:\/\/|file:\/\/|about:blank$)/i.test(value)) {
			const url = normalizeBrowserViewUrl(value);
			const opened = CommandsRegistry.hasCommand(EditorStartBrowserCommand)
				&& await this.commands.executeCommand<boolean>(EditorStartBrowserCommand, url);
			if (!opened) {
				await this.opener.open(url, { openExternal: true, allowCommands: false });
			}
			return;
		}
		const group = this.group;
		this.quickInput.quickAccess.show(value, {
			enabledProviderPrefixes: [''],
			providerOptions: {
				handleAccept: item => {
					if (this.isDisposed || !group || !('resource' in item) || !URI.isUri(item.resource)) return;
					void this.editors.openEditor({ resource: item.resource }, { pinned: true }, { groupId: group.id })
						.catch(error => this.notifications.error(error));
				},
			},
		});
	}

	override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (!(input instanceof EditorStartInput)) { throw new TypeError('Invalid editor start input'); }
	}
	override clearInput(): void { if (this.input) this.input.value = ''; }
	override layout(): void { }
	override focus(): void { this.input?.focus(); }
}

registerEditorPane({
	id: EmptyFileEditor.ID,
	name: 'New Tab',
	canOpen: input => input instanceof EditorStartInput ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => options.instantiationService!.createInstance(EmptyFileEditor),
});

EditorInputSerializers.registerStatic({
	typeId: EditorStartInput.ID,
	canSerialize: input => input instanceof EditorStartInput,
	serialize: () => ({}),
	deserialize: value => {
		requireRecord(value, 'Editor start input');
		return new EditorStartInput();
	},
});
