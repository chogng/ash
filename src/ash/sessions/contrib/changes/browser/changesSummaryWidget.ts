import './media/changesSummaryWidget.css';
import { h } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, derived, type IObservable } from '../../../../base/common/observable.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ChangesStatsWidget } from '../../../../workbench/browser/changesStatsWidget.js';
import type { TurnChangeSetSummary } from '../../../../workbench/services/chat/common/chatService.js';

/** Displays the visible Turn ledger statistics without caching business state. */
export class ChangesSummaryWidget extends Disposable {
	constructor(
		private readonly summary: IObservable<TurnChangeSetSummary['statistics'] | undefined>,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
	}

	public render(container: HTMLElement): void {
		const element = h(container.ownerDocument, 'p', { className: 'ash-sessions-changes-summary' });
		container.append(element);
		this._register(toDisposable(() => element.remove()));
		this._register(
			autorun(reader => {
				const statistics = this.summary.read(reader);
				element.hidden = !statistics;
			}),
		);
		this._register(
			this.instantiationService.createInstance(
				ChangesStatsWidget,
				element,
				derived(reader => {
					const statistics = this.summary.read(reader);
					return statistics
						? { files: statistics.files, insertions: statistics.additions, deletions: statistics.deletions }
						: undefined;
				}),
				true,
			),
		);
	}
}
