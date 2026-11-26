import './media/emptyFileEditor.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';

export const EditorFilePickerFocusedContext = new RawContextKey<boolean>('emptyFileEditorFocused', false);

interface FilePickerOptions {
	readonly isVisible: () => boolean;
	readonly openFile: (resource: URI) => Promise<void>;
}

/** Opens file Quick Access for the Files editor. */
export class EditorFilePicker extends Disposable {
	private readonly input: InputBox;

	constructor(
		container: HTMLElement,
		private readonly options: FilePickerOptions,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		const search = h(container.ownerDocument, 'form', { className: 'ash-empty-file-editor-search' });
		const searchLabel = localize('sessions.emptyFileEditor.searchFiles', 'Search files');
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
			this.show(input.value.trim());
		}));
		container.append(search);
	}

	show(value = ''): void {
		this.quickInput.quickAccess.show(value, {
			enabledProviderPrefixes: [''],
			providerOptions: {
				handleAccept: item => {
					if (this.isDisposed || !this.options.isVisible() || !('resource' in item) || !URI.isUri(item.resource)) return;
					void this.options.openFile(item.resource).catch(error => this.notifications.error(error));
				},
			},
		});
	}

	focus(): void { this.input.focus(); }
	clear(): void { this.input.value = ''; }
}
