import './media/changesStatsWidget.css';
import { h } from '../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { autorun, derived, type IObservable } from '../../base/common/observable.js';
import { localize } from '../../nls.js';
import { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { AnimatedCounterWidget } from './animatedCounterWidget.js';

export interface IChangesStats {
	readonly files: number;
	readonly insertions: number;
	readonly deletions: number;
}

export function getChangesStatsFilesLabel(files: number): string {
	return files === 1
		? localize('changesStatsWidget.file', '{0} file', files)
		: localize('changesStatsWidget.files', '{0} files', files);
}

/** Shared presentation of file and line counts; callers retain the statistics owner. */
export class ChangesStatsWidget extends Disposable {
	constructor(
		container: HTMLElement,
		stats: IObservable<IChangesStats | undefined>,
		showFiles: boolean,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		const element = h(container.ownerDocument, 'span', { className: 'ash-changes-stats' });
		container.append(element);
		this._register(toDisposable(() => element.remove()));
		if (showFiles) {
			const files = h(container.ownerDocument, 'span', { className: 'ash-changes-stats-files' });
			element.append(files, container.ownerDocument.createTextNode(' '));
			this._register(
				autorun(reader => {
					const value = stats.read(reader);
					files.textContent = value ? getChangesStatsFilesLabel(value.files) : '';
				}),
			);
		}
		this._register(
			instantiationService.createInstance(AnimatedCounterWidget, element, {
				prefix: '+',
				cssClassName: 'ash-changes-stats-added',
				direction: 'topToBottom',
				count: derived(reader => stats.read(reader)?.insertions),
			}),
		);
		element.append(container.ownerDocument.createTextNode(' '));
		this._register(
			instantiationService.createInstance(AnimatedCounterWidget, element, {
				prefix: '−',
				cssClassName: 'ash-changes-stats-removed',
				direction: 'bottomToTop',
				count: derived(reader => stats.read(reader)?.deletions),
			}),
		);
	}
}
