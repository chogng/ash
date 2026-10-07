import { Disposable } from '../../../common/lifecycle.js';
import type { IHistory } from '../../../common/history.js';
import { HistoryInputBox } from '../inputbox/inputbox.js';

export interface IFindInputOptions {
	readonly label: string;
	readonly placeholder?: string;
	readonly history?: IHistory<string>;
	readonly showHistoryHint?: () => boolean;
}

export class FindInput extends Disposable {
	public readonly domNode: HTMLElement;
	public readonly inputBox: HistoryInputBox;

	constructor(inputBox: HistoryInputBox) {
		super();
		this.inputBox = this._register(inputBox);
		this.domNode = this.inputBox.element;
	}
}
