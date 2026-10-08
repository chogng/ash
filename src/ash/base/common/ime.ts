import { Emitter, type Event } from "./event.js";
import { AbstractDisposable, markAsSingleton, setDisposableOwner } from "./lifecycle.js";

/**
 * Coordinates whether text-input surfaces should currently accept IME
 * composition.
 *
 * Keybinding dispatchers temporarily disable IME while waiting for another
 * chord. Text-input implementations observe the state and suppress composition
 * without coupling themselves to the keybinding service.
 */
export class InputMethodEditorState extends AbstractDisposable {
	private readonly _onDidChange = new Emitter<boolean>();
	private _enabled = true;

	readonly onDidChange: Event<boolean> = this._onDidChange.event;

	constructor() {
		super();
		setDisposableOwner(this._onDidChange, this);
	}

	get enabled(): boolean {
		return this._enabled;
	}

	enable(): void {
		this.setEnabled(true);
	}

	disable(): void {
		this.setEnabled(false);
	}

	protected override disposeCore(): void {
		this._onDidChange.dispose();
	}

	private setEnabled(enabled: boolean): void {
		this.assertNotDisposed();
		if (this._enabled === enabled) return;
		this._enabled = enabled;
		this._onDidChange.fire(enabled);
	}
}

/** Shared IME coordination state for the current JavaScript realm. */
export const IME = markAsSingleton(new InputMethodEditorState());
