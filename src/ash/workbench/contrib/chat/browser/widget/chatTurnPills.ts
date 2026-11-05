import { h } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { ChangesStatsWidget, getChangesStatsFilesLabel, type IChangesStats } from '../../../../browser/changesStatsWidget.js';
import type { IChatListItem } from '../../common/model/chatViewModel.js';

/** A completed reply's read-only entry point to the captured changes of its turn. */
export class ChatTurnChangesPill extends Disposable {
	private readonly button: Button;
	private readonly statistics = observableValue<IChangesStats | undefined>(this, undefined);
	private pending: AbortController | undefined;

	constructor(
		container: HTMLElement,
		private readonly row: HTMLElement,
		open: (signal: AbortSignal) => Promise<void>,
		@IInstantiationService instantiationService: IInstantiationService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		this.button = this._register(new Button(container, { ...defaultButtonStyles, label: '', icon: Lxicon.diff, presentation: 'quiet', size: 'small' }));
		this.button.hidden = true;
		const counts = h(container.ownerDocument, 'span', { attributes: { 'aria-hidden': 'true' } });
		this.button.domNode.append(counts);
		this._register(instantiationService.createInstance(ChangesStatsWidget, counts, this.statistics, false));
		this._register(toDisposable(() => this.pending?.abort()));
		this._register(this.button.onDidClick(async event => {
			event.stopPropagation();
			if (this.pending || this.button.hidden) return;
			const request = this.pending = new AbortController();
			this.button.domNode.setAttribute('aria-disabled', 'true');
			try {
				await open(request.signal);
			} catch (error) {
				if (!request.signal.aborted && !isCancellationError(error)) notifications.error(error instanceof Error ? error : String(error));
			} finally {
				this.pending = undefined;
				if (!this.isDisposed) this.button.domNode.removeAttribute('aria-disabled');
			}
		}));
	}

	render(changes: IChatListItem['turnChanges']): void {
		if (!changes) {
			this.pending?.abort();
			if (this.button.hasFocus()) this.row.focus({ preventScroll: true });
			this.button.hidden = true;
			this.statistics.set(undefined);
			return;
		}
		const { files, additions, deletions } = changes;
		this.button.label = getChangesStatsFilesLabel(files);
		const name = localize('chat.turnChanges.open', 'Open Turn Changes: {0}, added {1}, removed {2}', this.button.label, additions, deletions);
		this.button.domNode.setAttribute('aria-label', name);
		this.button.setTitle(name);
		this.statistics.set({ files, insertions: additions, deletions });
		this.button.hidden = false;
	}
}
