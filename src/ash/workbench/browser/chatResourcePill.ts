import './media/chatResourcePill.css';
import { onUnexpectedError } from '../../base/common/errors.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { Lxicon } from '../../base/common/lxicons.js';
import type { URI } from '../../base/common/uri.js';
import { localize } from '../../nls.js';
import { FileKind } from '../../platform/files/common/files.js';
import { createChatPillButton } from './chatPills.js';
import { IResourceLabelService, type ResourceLabels } from './labels.js';

interface IChatResourcePillEntry {
	readonly label: string;
	readonly resource?: URI;
	open(): Promise<void>;
}

/** A single resource with a themed label and a host-owned open action. */
export class ChatResourcePill extends Disposable {
	constructor(
		container: HTMLElement,
		entry: IChatResourcePillEntry,
		resourceLabels: ResourceLabels | undefined,
		@IResourceLabelService labelService: IResourceLabelService,
	) {
		super();
		const title = localize({ bundle: 'ash.workbench', key: 'chatResourcePill.open' }, 'Open {0}', entry.label);
		const button = this._register(createChatPillButton(container, {
			label: '', ariaLabel: title, title, presentation: 'secondary',
		}));
		button.domNode.classList.add('ash-chat-resource-pill');
		const labels = resourceLabels ?? this._register(labelService.createGroup());
		const label = this._register(labels.create(button.domNode));
		if (entry.resource) {
			// The button owns the hover. An empty title suppresses the label's automatic path hover.
			label.setResource({ name: entry.label, resource: entry.resource }, { fileKind: FileKind.File, title: '' });
		} else {
			label.setLabel(entry.label, undefined, { icon: Lxicon.file });
		}
		let opening = false;
		this._register(button.onDidClick(async () => {
			if (opening) return;
			opening = true;
			button.domNode.setAttribute('aria-busy', 'true');
			try {
				await entry.open();
			} catch (error) {
				onUnexpectedError(error);
			} finally {
				opening = false;
				button.domNode.removeAttribute('aria-busy');
			}
		}));
	}
}
