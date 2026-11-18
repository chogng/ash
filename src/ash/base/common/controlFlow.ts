import { BugIndicatingError } from './errors.js';

/** A synchronous barrier for callbacks that can trigger themselves indirectly. */
export class ReentrancyBarrier {
	private occupied = false;

	public get isOccupied(): boolean {
		return this.occupied;
	}

	/** Runs a non-optional operation while suppressing other callbacks on this barrier. */
	public run(runner: () => void): void {
		const wasOccupied = this.occupied;
		this.occupied = true;
		try {
			runner();
		} finally {
			this.occupied = wasOccupied;
		}
	}

	public runExclusivelyOrSkip(runner: () => void): void {
		if (!this.isOccupied) {
			this.run(runner);
		}
	}

	public runExclusivelyOrThrow(runner: () => void): void {
		if (this.isOccupied) {
			throw new BugIndicatingError('ReentrancyBarrier: reentrant call detected!');
		}
		this.run(runner);
	}

	public makeExclusiveOrSkip<TArgs extends unknown[]>(runner: (...args: TArgs) => void): (...args: TArgs) => void {
		return (...args) => this.runExclusivelyOrSkip(() => runner(...args));
	}
}
