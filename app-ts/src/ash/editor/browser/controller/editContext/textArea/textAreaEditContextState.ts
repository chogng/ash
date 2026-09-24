import { commonPrefixLength, commonSuffixLength } from '../../../../../base/common/strings.js';
import { type Position } from '../../../../common/core/position.js';
import { type Range } from '../../../../common/core/range.js';
import { type ISimpleScreenReaderContentState } from '../screenReaderUtils.js';

export const _debugComposition = false;

export interface ITextAreaWrapper {
	getValue(): string;
	setValue(reason: string, value: string): void;
	getSelectionStart(): number;
	getSelectionEnd(): number;
	setSelectionRange(reason: string, selectionStart: number, selectionEnd: number): void;
}

export interface ITypeData {
	readonly text: string;
	readonly replacePrevCharCnt: number;
	readonly replaceNextCharCnt: number;
	readonly positionDelta: number;
}

/** Snapshot and diff helpers for the textarea-backed edit context. */
export class TextAreaState {
	static readonly EMPTY = new TextAreaState('', 0, 0, null, undefined);

	constructor(
		readonly value: string,
		/** Direction-aware selection start inside value. */
		readonly selectionStart: number,
		/** Direction-aware selection end inside value. */
		readonly selectionEnd: number,
		/** The editor range represented by the selected content, if any. */
		readonly selection: Range | null,
		/** Visible line count before the selection in the projected textarea value. */
		readonly newlineCountBeforeSelection: number | undefined,
	) {}

	toString(): string {
		return `[ <${this.value}>, selectionStart: ${this.selectionStart}, selectionEnd: ${this.selectionEnd}]`;
	}

	static readFromTextArea(textArea: ITextAreaWrapper, previousState: TextAreaState | null): TextAreaState {
		const value = textArea.getValue();
		const selectionStart = textArea.getSelectionStart();
		const selectionEnd = textArea.getSelectionEnd();
		let newlineCountBeforeSelection: number | undefined;
		if (previousState) {
			const valueBeforeSelectionStart = value.substring(0, selectionStart);
			const previousValueBeforeSelectionStart = previousState.value.substring(0, previousState.selectionStart);
			if (valueBeforeSelectionStart === previousValueBeforeSelectionStart) {
				newlineCountBeforeSelection = previousState.newlineCountBeforeSelection;
			}
		}
		return new TextAreaState(value, selectionStart, selectionEnd, null, newlineCountBeforeSelection);
	}

	collapseSelection(): TextAreaState {
		if (this.selectionStart === this.value.length) return this;
		return new TextAreaState(this.value, this.value.length, this.value.length, null, undefined);
	}

	isWrittenToTextArea(textArea: ITextAreaWrapper, select: boolean): boolean {
		if (this.value !== textArea.getValue()) return false;
		return !select || (
			this.selectionStart === textArea.getSelectionStart() &&
			this.selectionEnd === textArea.getSelectionEnd()
		);
	}

	writeToTextArea(reason: string, textArea: ITextAreaWrapper, select: boolean): void {
		if (_debugComposition) console.log(`writeToTextArea ${reason}: ${this.toString()}`);
		textArea.setValue(reason, this.value);
		if (select) textArea.setSelectionRange(reason, this.selectionStart, this.selectionEnd);
	}

	deduceEditorPosition(offset: number): [Position | null, number, number] {
		const selectionStart = Math.min(this.selectionStart, this.selectionEnd);
		const selectionEnd = Math.max(this.selectionStart, this.selectionEnd);
		if (offset <= selectionStart) {
			return this._finishDeduceEditorPosition(this.selection?.getStartPosition() ?? null, this.value.substring(offset, selectionStart), -1);
		}
		if (offset >= selectionEnd) {
			return this._finishDeduceEditorPosition(this.selection?.getEndPosition() ?? null, this.value.substring(selectionEnd, offset), 1);
		}
		const textBeforeOffset = this.value.substring(selectionStart, offset);
		if (!textBeforeOffset.includes(String.fromCharCode(8230))) {
			return this._finishDeduceEditorPosition(this.selection?.getStartPosition() ?? null, textBeforeOffset, 1);
		}
		return this._finishDeduceEditorPosition(this.selection?.getEndPosition() ?? null, this.value.substring(offset, selectionEnd), -1);
	}

	private _finishDeduceEditorPosition(anchor: Position | null, deltaText: string, signum: number): [Position | null, number, number] {
		let lineFeedCount = 0;
		for (const character of deltaText) {
			if (character === '\n') lineFeedCount += 1;
		}
		return [anchor, signum * deltaText.length, lineFeedCount];
	}

	static deduceInput(previousState: TextAreaState, currentState: TextAreaState, _couldBeEmojiInput: boolean): ITypeData {
		if (!previousState) {
			return { text: '', replacePrevCharCnt: 0, replaceNextCharCnt: 0, positionDelta: 0 };
		}
		if (_debugComposition) {
			console.log('------------------------deduceInput');
			console.log(`PREVIOUS STATE: ${previousState.toString()}`);
			console.log(`CURRENT STATE: ${currentState.toString()}`);
		}

		const prefixLength = Math.min(
			commonPrefixLength(previousState.value, currentState.value),
			previousState.selectionStart,
			currentState.selectionStart,
		);
		const suffixLength = Math.min(
			commonSuffixLength(previousState.value, currentState.value),
			previousState.value.length - previousState.selectionEnd,
			currentState.value.length - currentState.selectionEnd,
		);
		const previousValue = previousState.value.substring(prefixLength, previousState.value.length - suffixLength);
		const currentValue = currentState.value.substring(prefixLength, currentState.value.length - suffixLength);
		const previousSelectionStart = previousState.selectionStart - prefixLength;
		const previousSelectionEnd = previousState.selectionEnd - prefixLength;
		const currentSelectionStart = currentState.selectionStart - prefixLength;
		const currentSelectionEnd = currentState.selectionEnd - prefixLength;

		if (currentSelectionStart === currentSelectionEnd) {
			return {
				text: currentValue,
				replacePrevCharCnt: previousState.selectionStart - prefixLength,
				replaceNextCharCnt: 0,
				positionDelta: 0,
			};
		}
		return {
			text: currentValue,
				replacePrevCharCnt: previousSelectionEnd - previousSelectionStart,
			replaceNextCharCnt: 0,
			positionDelta: 0,
		};
	}

	static deduceAndroidCompositionInput(previousState: TextAreaState, currentState: TextAreaState): ITypeData {
		if (!previousState) {
			return { text: '', replacePrevCharCnt: 0, replaceNextCharCnt: 0, positionDelta: 0 };
		}
		if (previousState.value === currentState.value) {
			return {
				text: '',
				replacePrevCharCnt: 0,
				replaceNextCharCnt: 0,
				positionDelta: currentState.selectionEnd - previousState.selectionEnd,
			};
		}

		const prefixLength = Math.min(commonPrefixLength(previousState.value, currentState.value), previousState.selectionEnd);
		const suffixLength = Math.min(commonSuffixLength(previousState.value, currentState.value), previousState.value.length - previousState.selectionEnd);
		const previousValue = previousState.value.substring(prefixLength, previousState.value.length - suffixLength);
		const currentValue = currentState.value.substring(prefixLength, currentState.value.length - suffixLength);
		return {
			text: currentValue,
			replacePrevCharCnt: previousState.selectionEnd - prefixLength,
			replaceNextCharCnt: previousValue.length - (previousState.selectionEnd - prefixLength),
			positionDelta: currentState.selectionEnd - prefixLength - currentValue.length,
		};
	}

	static fromScreenReaderContentState(state: ISimpleScreenReaderContentState) {
		return new TextAreaState(
			state.value,
			state.selectionStart,
			state.selectionEnd,
			state.selection,
			state.newlineCountBeforeSelection,
		);
	}
}
