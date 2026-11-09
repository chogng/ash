import './filterTabs.css';
import './sessionsSearchDialog.css';
import { h } from '../../../base/browser/dom.js';
import { Button } from '../../../base/browser/ui/button/button.js';
import { Dialog } from '../../../base/browser/ui/dialog/dialog.js';
import { Lxicon } from '../../../base/common/lxicons.js';
import { localize } from '../../../nls.js';
import { defaultButtonStyles, defaultCheckboxStyles, defaultDialogStyles, defaultInputBoxStyles } from '../../../platform/theme/browser/defaultStyles.js';

interface SessionsSearchDialogOptions {
	readonly title: string;
	readonly placeholder: string;
	readonly ariaLabel: string;
	readonly className: string;
}

/** A search-first dialog; callers own the query behavior and results. */
export class SessionsSearchDialog extends Dialog {
	readonly input: HTMLInputElement;

	constructor(container: HTMLElement, content: HTMLElement, options: SessionsSearchDialogOptions) {
		super(container, options.title, [], {
			buttonStyles: defaultButtonStyles,
			checkboxStyles: defaultCheckboxStyles,
			inputBoxStyles: defaultInputBoxStyles,
			dialogStyles: defaultDialogStyles,
			extraClasses: ['ash-sessions-search-shell', options.className],
			disableCloseButton: true,
			disableDefaultAction: true,
			closeOnBackdropClick: true,
			renderBody: body => body.append(content),
		});
		const document = container.ownerDocument;
		content.classList.add('ash-sessions-search-content');
		const header = h(document, 'header', { className: 'ash-sessions-search-header' });
		this.input = h(document, 'input', {
			properties: { type: 'search', placeholder: options.placeholder },
			attributes: { 'aria-label': options.ariaLabel },
		});
		header.append(this.input);
		this._register(new Button(header, {
			...defaultButtonStyles,
			label: localize('sessions.search.close', 'Close'),
			icon: Lxicon.close,
			iconOnly: true,
			presentation: 'quiet',
			onClick: () => this.requestClose(),
		}));
		content.prepend(header);
	}
}
