import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ITerminalService, type ITerminalInstance, type ITerminalView } from './terminal.js';
import type { IView } from '../../../common/views.js';
import type { IChatContextTarget } from '../../../services/chat/common/chatContextService.js';
import { CHAT_VIEW_ID } from '../../chat/common/chat.js';
import { TERMINAL_VIEW_ID } from '../common/terminal.js';
import { captureTerminalAttachment } from './chatTerminalCommandMirror.js';

/** An instance-menu invocation captures context before switching to the Chat draft. */
export class TerminalTabsChatEntry extends Disposable {
	constructor(
		@ITerminalService private readonly terminals: ITerminalService,
		@IViewsService private readonly views: IViewsService,
	) {
		super();
	}

	async attach(instance: ITerminalInstance): Promise<void> {
		if (this.isDisposed || !this.terminals.instances.includes(instance)) return;
		const controller = new AbortController();
		const lease = this._register(toDisposable(() => controller.abort()));
		const closed = this.terminals.onDidDisposeInstance(removed => {
			if (removed === instance) controller.abort();
		});
		try {
			const attachment = await captureTerminalAttachment(
				instance,
				this.views.getViewWithId<ITerminalView>(TERMINAL_VIEW_ID),
				controller.signal,
			);
			if (!attachment || controller.signal.aborted) return;
			const chat = await this.views.openView<IView & IChatContextTarget>(CHAT_VIEW_ID, true);
			if (!controller.signal.aborted) chat?.addContext(attachment);
		} finally {
			closed.dispose();
			this._store.delete(lease);
			lease.dispose();
		}
	}
}
