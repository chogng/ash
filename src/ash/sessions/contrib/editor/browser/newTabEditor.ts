import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { EditorReplacementTarget } from '../../../../workbench/services/editor/common/editorService.js';
import { Menus } from '../../../browser/menus.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsEntryService } from '../../../services/layout/common/sessionsEntryService.js';
import { NEW_BROWSER_TAB_COMMAND_ID } from './addTabActions.js';
import { EditorFilePicker, EditorFilePickerFocusedContext } from './editorFilePicker.js';
import { NewTabEditorInput } from './newTabEditorInput.js';

export class NewTabEditor extends EditorPane {
	readonly id = NewTabEditorInput.EDITOR_ID;
	private readonly inputResources = this._register(new DisposableStore());
	private input: NewTabEditorInput | undefined;
	private search: EditorFilePicker | undefined;
	private actions: HTMLElement | undefined;
	private shortcuts: HTMLElement | undefined;
	private scope: IContextKeyService | undefined;

	constructor(
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
		@IMenuService private readonly menus: IMenuService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@ICommandService private readonly commands: ICommandService,
		@ISessionsEntryService private readonly entries: ISessionsEntryService,
		@IOpenerService private readonly opener: IOpenerService,
		@INotificationService private readonly notifications: INotificationService,
		@ISessionsService private readonly sessions: ISessionsService,
	) {
		super(NewTabEditorInput.EDITOR_ID, theme, storage);
	}

	override create(parent: HTMLElement): void {
		super.create(parent);
		const document = parent.ownerDocument;
		const surface = h(document, 'div', { className: 'ash-empty-file-editor ash-sessions-new-tab' });
		const content = h(document, 'div', { className: 'ash-empty-file-editor-content' });
		parent.append(surface);
		surface.append(content);
		const scope = this.scope = this._register(this.contextKeys.createScoped(surface));
		EditorFilePickerFocusedContext.bindTo(scope).set(true);
		this.search = this._register(this.instantiation.createInstance(EditorFilePicker, content, {
			isVisible: () => this.isVisible(),
			scopeKey: () => `${this.sessions.navigationRevision}:${this.input?.resource}`,
			openFile: async (resource: URI) => {
				const target = this.replacement;
				if (target) await this.entries.openToolFile(resource, target);
			},
			openUrl: async (url: string) => {
				const target = this.replacement;
				if (!target) return;
				const opened = CommandsRegistry.hasCommand(NEW_BROWSER_TAB_COMMAND_ID)
					&& await this.commands.executeCommand<boolean>(NEW_BROWSER_TAB_COMMAND_ID, url, target);
				if (!opened) await this.opener.open(url, { openExternal: true, allowCommands: false });
			},
		}));
		const label = localize('sessions.emptyFileEditor.actions', 'Open');
		const shortcuts = this.shortcuts = h(document, 'section', { className: 'ash-empty-file-editor-shortcuts', attributes: { 'aria-label': label } });
		const actions = this.actions = h(document, 'div', { className: 'ash-empty-file-editor-actions' });
		shortcuts.append(h(document, 'h2', {}, label), actions);
		content.append(shortcuts);
	}

	private get replacement(): EditorReplacementTarget | undefined {
		return this.group && this.input ? new EditorReplacementTarget(this.group.id, this.input) : undefined;
	}

	override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (!(input instanceof NewTabEditorInput)) throw new TypeError('Invalid New Tab input');
		this.clearInput();
		this.input = input;
		const scope = this.scope!;
		const menu = this.inputResources.add(this.menus.createMenu(Menus.SessionsEmptyEditorGroupAddTab, scope));
		const buttons = this.inputResources.add(new DisposableStore());
		const render = () => {
			buttons.clear();
			const actions = this.actions!;
			actions.replaceChildren();
			for (const [, entries] of menu.getActions({ arg: this.replacement })) {
				for (const action of entries) {
					buttons.add(new Button(actions, {
						...defaultButtonStyles, label: action.label, icon: action.icon, enabled: action.enabled, presentation: 'secondary',
						onClick: () => {
							void Promise.resolve().then(() => action.run()).catch(error => {
								if (!isCancellationError(error)) this.notifications.error(error);
							});
						},
					}));
				}
			}
			this.shortcuts!.hidden = !actions.childElementCount;
		};
		this.inputResources.add(menu.onDidChange(render));
		render();
	}

	openFile(): void { this.search?.show(); }
	override focus(): void { this.search?.focus(); }
	override layout(): void { }
	override clearInput(): void {
		this.input = undefined;
		this.inputResources.clear();
		this.search?.clear();
	}
}
