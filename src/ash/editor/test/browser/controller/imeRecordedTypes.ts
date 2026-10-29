import { OperatingSystem } from '../../../../base/common/platform.js';

export interface IRecordedTextareaState {
	selectionDirection: 'forward' | 'backward' | 'none';
	selectionEnd: number;
	selectionStart: number;
	value: string;
}

export interface IRecordedKeyboardEvent {
	timeStamp: number;
	state: IRecordedTextareaState;
	type: 'keydown' | 'keypress' | 'keyup';
	altKey: boolean;
	charCode: number;
	code: string;
	ctrlKey: boolean;
	isComposing: boolean;
	key: string;
	keyCode: number;
	location: number;
	metaKey: boolean;
	repeat: boolean;
	shiftKey: boolean;
}

export interface IRecordedCompositionEvent {
	timeStamp: number;
	state: IRecordedTextareaState;
	type: 'compositionstart' | 'compositionupdate' | 'compositionend';
	data: string;
}

export interface IRecordedInputEvent {
	timeStamp: number;
	state: IRecordedTextareaState;
	type: 'beforeinput' | 'input';
	data: string | null;
	inputType: string;
	isComposing: boolean | undefined;
}

export type IRecordedEvent = IRecordedKeyboardEvent | IRecordedCompositionEvent | IRecordedInputEvent;

export interface IRecorded {
	env: {
		OS: OperatingSystem;
		browser: string;
	};
	initial: IRecordedTextareaState;
	events: IRecordedEvent[];
	final: IRecordedTextareaState;
}
