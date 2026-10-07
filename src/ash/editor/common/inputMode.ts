import { Emitter, type Event } from '../../base/common/event.js';

/** Realm-wide insert/overtype input state consumed while recomputing cursor configuration. */
export class InputMode {
	private static readonly changeEmitter = new Emitter<'insert' | 'overtype'>();
	private static inputMode: 'insert' | 'overtype' = 'insert';

	public static readonly onDidChangeInputMode: Event<'insert' | 'overtype'> = InputMode.changeEmitter.event;

	public static getInputMode(): 'insert' | 'overtype' {
		return InputMode.inputMode;
	}

	public static setInputMode(inputMode: 'insert' | 'overtype'): void {
		if (inputMode !== 'insert' && inputMode !== 'overtype') throw new TypeError('Editor input mode must be insert or overtype');
		if (inputMode === InputMode.inputMode) return;
		InputMode.inputMode = inputMode;
		InputMode.changeEmitter.fire(inputMode);
	}
}
