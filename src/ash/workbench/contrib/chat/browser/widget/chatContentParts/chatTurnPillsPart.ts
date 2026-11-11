import { isCancellationError } from '../../../../../../base/common/errors.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import type { IChatListItem } from '../../../common/model/chatViewModel.js';
import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import type { ChatTurnFileChange } from '../../chatResponseFileChangesService.js';
import { ChatEditStatsButton } from './chatEditStatsButton.js';
import { ChatCheckpointFileChangesSummaryContentPart } from './chatChangesSummaryPart.js';

/** A completed reply's read-only entry point to the captured changes of its turn. */
export class ChatTurnPillsContentPart extends Disposable {
	private readonly stats: ChatEditStatsButton;
	private pending: AbortController | undefined;
	private readonly files?: ChatCheckpointFileChangesSummaryContentPart;

	constructor(
		container: HTMLElement,
		private readonly row: HTMLElement,
		open: (signal: AbortSignal) => Promise<void>,
		disclosure: { readonly expanded: boolean; readonly onChange: (expanded: boolean) => void; } | undefined,
		@IInstantiationService instantiationService: IInstantiationService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		this.stats = this._register(instantiationService.createInstance(ChatEditStatsButton, container));
		if (disclosure) {
			const files = this.files = this._register(instantiationService.createInstance(ChatCheckpointFileChangesSummaryContentPart, row, disclosure.expanded));
			container.before(files.domNode);
			this._register(files.onDidChangeHeight(() => disclosure.onChange(files.domNode.open)));
		}
		this._register(toDisposable(() => this.pending?.abort()));
		const { button } = this.stats;
		this._register(button.onDidClick(async event => {
			event.stopPropagation();
			if (this.pending || button.hidden) return;
			const request = this.pending = new AbortController();
			button.domNode.setAttribute('aria-disabled', 'true');
			try {
				await open(request.signal);
			} catch (error) {
				if (!request.signal.aborted && !isCancellationError(error)) notifications.error(error instanceof Error ? error : String(error));
			} finally {
				this.pending = undefined;
				if (!this.isDisposed) button.domNode.removeAttribute('aria-disabled');
			}
		}));
	}

	render(changes: IChatListItem['turnChanges'], fileDiffs: readonly ChatTurnFileChange[], beforeLayout?: () => void): boolean {
		const changed = this.files?.render(changes ? fileDiffs : [], beforeLayout) === true;
		if (!changes) {
			if (this.files) this.files.domNode.open = false;
			this.pending?.abort();
			if (this.stats.button.hasFocus()) this.row.focus({ preventScroll: true });
		}
		return this.stats.render(changes, changed ? undefined : beforeLayout) || changed;
	}
}
