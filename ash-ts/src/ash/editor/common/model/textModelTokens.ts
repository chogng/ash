import type { IState } from '../languages.js';

/** Stores the state after each tokenized line in one document version. */
export class TokenizationStateStore<TState extends IState> {
	private readonly endStates = new Map<number, TState>();

	public getEndState(lineNumber: number): TState | null {
		return this.endStates.get(lineNumber) ?? null;
	}

	public setEndState(lineNumber: number, state: TState): boolean {
		if (this.endStates.get(lineNumber)?.equals(state)) {
			return false;
		}
		this.endStates.set(lineNumber, state);
		return true;
	}
}
