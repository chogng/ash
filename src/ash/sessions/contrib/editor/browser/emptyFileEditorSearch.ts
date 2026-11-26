import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { normalizeBrowserViewUrl } from '../../../../platform/browserView/common/browserView.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import type { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { NEW_BROWSER_TAB_COMMAND_ID } from './addTabActions.js';

/** Runs file Quick Access in the Files editor's group and delegates URLs to the window. */
export class EmptyFileEditorSearch extends Disposable {
	private readonly input: InputBox;

	constructor(
		container: HTMLElement,
		private readonly editor: EditorPane,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IEditorService private readonly editors: IEditorService,
		@ICommandService private readonly commands: ICommandService,
		@IOpenerService private readonly opener: IOpenerService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		const search = h(container.ownerDocument, 'form', { className: 'ash-empty-file-editor-search' });
		const searchLabel = localize('sessions.emptyFileEditor.searchOrUrl', 'Search files or enter a URL');
		const input = this.input = this._register(new InputBox(search, {
			inputBoxStyles: defaultInputBoxStyles, presentation: 'field', ariaLabel: searchLabel, placeholder: searchLabel,
		}));
		this._register(new Button(search, {
			...defaultButtonStyles,
			label: localize('sessions.emptyFileEditor.go', 'Go'),
			icon: Lxicon.arrowRight, iconOnly: true, type: 'submit', presentation: 'secondary',
		}));
		this._register(addDisposableListener(search, 'submit', event => {
			event.preventDefault();
			void this.submit(input.value.trim()).catch(error => this.notifications.error(error));
		}));
		container.append(search);
	}

	private async submit(value: string): Promise<void> {
		if (/^(?:https?:\/\/|file:\/\/|about:blank$)/i.test(value)) {
			const url = normalizeBrowserViewUrl(value);
			const opened = CommandsRegistry.hasCommand(NEW_BROWSER_TAB_COMMAND_ID)
				&& await this.commands.executeCommand<boolean>(NEW_BROWSER_TAB_COMMAND_ID, url);
			if (!opened) {
				await this.opener.open(url, { openExternal: true, allowCommands: false });
			}
			return;
		}
		this.show(value);
	}

	show(value = ''): void {
		const group = this.editor.group;
		this.quickInput.quickAccess.show(value, {
			enabledProviderPrefixes: [''],
			providerOptions: {
				handleAccept: item => {
					if (this.isDisposed || !this.editor.isVisible() || !group || !('resource' in item) || !URI.isUri(item.resource)) return;
					void this.editors.openEditor({ resource: item.resource }, { pinned: true }, { groupId: group.id })
						.catch(error => this.notifications.error(error));
				},
			},
		});
	}

	focus(): void { this.input.focus(); }
	clear(): void { this.input.value = ''; }
}
