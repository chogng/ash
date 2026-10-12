import './media/changesSummaryWidget.css';
import { h } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, type IObservable } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import type { TurnChangeSetSummary } from '../../../../workbench/services/chat/common/chatService.js';

/** Displays the visible Turn ledger statistics without caching business state. */
export class ChangesSummaryWidget extends Disposable {
	constructor(private readonly summary: IObservable<TurnChangeSetSummary['statistics'] | undefined>) {
		super();
	}

	public render(container: HTMLElement): void {
		const element = h(container.ownerDocument, 'p', { className: 'ash-sessions-changes-summary' });
		container.append(element);
		this._register(toDisposable(() => element.remove()));
		this._register(autorun(reader => {
			const statistics = this.summary.read(reader);
			element.hidden = !statistics;
			element.textContent = statistics ? localize('sessions.changes.summary', '{0} file changes · +{1} −{2}', statistics.files, statistics.additions, statistics.deletions) : '';
		}));
	}
}
