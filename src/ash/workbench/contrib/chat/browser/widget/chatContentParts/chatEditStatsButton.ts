import { h } from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { observableValue } from '../../../../../../base/common/observable.js';
import { localize } from '../../../../../../nls.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { ChangesStatsWidget, getChangesStatsFilesLabel, type IChangesStats } from '../../../../../browser/changesStatsWidget.js';
import type { IChatListItem } from '../../../common/model/chatViewModel.js';
import './media/chatEditStatsButton.css';

/** Projects a Turn's file and line totals into its review control. */
export class ChatEditStatsButton extends Disposable {
	readonly button: Button;
	private readonly statistics = observableValue<IChangesStats | undefined>(this, undefined);

	constructor(container: HTMLElement, @IInstantiationService instantiation: IInstantiationService) {
		super();
		this.button = this._register(new Button(container, { ...defaultButtonStyles, label: '', icon: Lxicon.diff, presentation: 'quiet', size: 'small' }));
		this.button.hidden = true;
		const counts = h(container.ownerDocument, 'span', { className: 'ash-chat-edit-stats', attributes: { 'aria-hidden': 'true' } });
		this.button.domNode.append(counts);
		this._register(instantiation.createInstance(ChangesStatsWidget, counts, this.statistics, false));
	}

	render(changes: IChatListItem['turnChanges'], beforeLayout?: () => void): boolean {
		const current = this.statistics.get();
		if (!changes) {
			if (!current) return false;
			beforeLayout?.();
			this.button.hidden = true;
			this.statistics.set(undefined);
			return true;
		}
		const { files, additions, deletions } = changes;
		if (current?.files === files && current.insertions === additions && current.deletions === deletions) return false;
		beforeLayout?.();
		this.button.label = getChangesStatsFilesLabel(files);
		const name = localize('chat.turnChanges.open', 'Open Turn Changes: {0}, added {1}, removed {2}', this.button.label, additions, deletions);
		this.button.domNode.setAttribute('aria-label', name);
		this.button.setTitle(name);
		this.statistics.set({ files, insertions: additions, deletions });
		this.button.hidden = false;
		return true;
	}
}
