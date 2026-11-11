import { h } from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { OPEN_EXTENSIONS_COMMAND_ID, type ExtensionsOpenOptions } from '../../../../../../platform/extensionManagement/common/extensionManagementService.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import './media/chatExtensionsContent.css';

/** Opens the existing Extensions search from a typed approval while leaving approval with the caller. */
export class ChatExtensionsContentPart extends Disposable {
	readonly domNode: HTMLUListElement;

	constructor(document: Document, extensions: readonly string[],
		@ICommandService commands: ICommandService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		this.domNode = h(document, 'ul', {
			className: 'ash-chat-extension-requests',
			attributes: { 'aria-label': localize('chat.tool.installExtensions', 'Extensions requested for installation') },
		});
		for (const id of extensions) {
			const row = h(document, 'li', h(document, 'code', id));
			this.domNode.append(row);
			// Keep unrecognized IDs readable without interpreting them as search directives.
			if (!/^[a-z0-9][a-z0-9_.-]{0,255}$/iu.test(id)) continue;
			this._register(new Button(row, {
				...defaultButtonStyles,
				label: localize('chat.tool.findExtension', 'Find in Extensions'),
				ariaLabel: localize('chat.tool.findNamedExtension', 'Find {0} in Extensions', id),
				presentation: 'secondary',
				size: 'small',
				onClick: () => {
					if (this.isDisposed || !this.domNode.isConnected) return;
					void commands.executeCommand(OPEN_EXTENSIONS_COMMAND_ID, { mode: 'browse', query: id } satisfies ExtensionsOpenOptions)
						.catch(error => { if (!this.isDisposed) notifications.error(error); });
				},
			}));
		}
	}
}
