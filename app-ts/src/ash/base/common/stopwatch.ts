const highResolutionNow = typeof globalThis.performance?.now === 'function'
	? globalThis.performance.now.bind(globalThis.performance)
	: Date.now;

export class StopWatch {
	private startTime: number;
	private stopTime: number | undefined;
	private readonly now: () => number;

	static create(highResolution = true): StopWatch { return new StopWatch(highResolution); }

	constructor(highResolution = true) {
		this.now = highResolution ? highResolutionNow : Date.now;
		this.startTime = this.now();
	}

	stop(): void { this.stopTime ??= this.now(); }
	reset(): void { this.startTime = this.now(); this.stopTime = undefined; }
	elapsed(): number { return (this.stopTime ?? this.now()) - this.startTime; }
}
