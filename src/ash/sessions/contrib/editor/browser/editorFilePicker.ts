import './media/emptyFileEditor.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { normalizeBrowserViewUrl } from '../../../../platform/browserView/common/browserView.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';

export const EditorFilePickerFocusedContext = new RawContextKey<boolean>('emptyFileEditorFocused', false);

interface FilePickerOptions {
	readonly isVisible: () => boolean;
	readonly openFile: (resource: URI) => Promise<void>;
	readonly openUrl?: (url: string) => Promise<void>;
	readonly scopeKey?: () => string;
}

/** Runs file Quick Access for its host and optionally accepts browser addresses. */
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
		const searchLabel = options.openUrl
			? localize('sessions.emptyFileEditor.searchOrUrl', 'Search files or enter a URL')
			: localize('sessions.emptyFileEditor.searchFiles', 'Search files');
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
		if (this.options.openUrl && /^(?:https?:\/\/|file:\/\/|about:blank$)/i.test(value)) {
			await this.options.openUrl(normalizeBrowserViewUrl(value));
			return;
		}
		this.show(value);
	}

	show(value = ''): void {
		const scope = this.options.scopeKey?.();
		this.quickInput.quickAccess.show(value, {
			enabledProviderPrefixes: [''],
			providerOptions: {
				handleAccept: item => {
					if (this.isDisposed || !this.options.isVisible() || scope !== this.options.scopeKey?.()
						|| !('resource' in item) || !URI.isUri(item.resource)) return;
					void this.options.openFile(item.resource).catch(error => this.notifications.error(error));
				},
			},
		});
	}

	focus(): void { this.input.focus(); }
	clear(): void { this.input.value = ''; }
}
