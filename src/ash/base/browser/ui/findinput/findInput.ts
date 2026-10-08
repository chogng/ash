import { Disposable } from '../../../common/lifecycle.js';
import { HistoryInputBox, type IHistoryInputOptions } from '../inputbox/inputbox.js';

export interface IFindInputOptions<Flexible extends boolean = false> extends IHistoryInputOptions<Flexible> {
	readonly label: string;
}

export class FindInput<Flexible extends boolean = false> extends Disposable {
	public readonly domNode: HTMLElement;
	public readonly inputBox: HistoryInputBox<Flexible>;

	constructor(inputBox: HistoryInputBox<Flexible>) {
		super();
		this.inputBox = this._register(inputBox);
		this.domNode = this.inputBox.element;
	}
}
