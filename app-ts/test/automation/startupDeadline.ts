/** One monotonic budget shared by process launch, navigation, and Workbench restoration. */
export class StartupDeadline {
	private readonly expiresAt = performance.now() + 30_000;

	remaining(stage: string): number {
		const remaining = this.expiresAt - performance.now();
		// Playwright interprets zero as no timeout, so expired stages must fail before dispatch.
		if (remaining <= 0) throw this.timeoutError(stage);
		return remaining;
	}

	async run<T>(stage: string, action: (timeout: number) => Promise<T>): Promise<T> {
		const timeout = this.remaining(stage);
		let timer: ReturnType<typeof setTimeout>;
		const expired = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(this.timeoutError(stage)), timeout);
		});
		try {
			const result = await Promise.race([action(timeout), expired]);
			this.remaining(stage);
			return result;
		} finally {
			clearTimeout(timer!);
		}
	}

	private timeoutError(stage: string): Error {
		return new Error(`Startup exceeded its 30000ms deadline while waiting for ${stage}`);
	}
}
