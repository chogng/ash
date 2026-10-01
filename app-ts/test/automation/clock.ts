import type { Page } from '@playwright/test';

/** Install before navigation; the returned action pauses time after the page is ready. */
export async function installClock(page: Pick<Page, 'clock'>): Promise<() => Promise<void>> {
	const time = Date.UTC(2026, 0, 1);
	await page.clock.install({ time });
	// Loading timers keep running, but RPC latency cannot move the pause target into the past.
	await page.clock.setFixedTime(time);
	return async () => {
		await page.clock.pauseAt(time);
		// Resume Date progression under runFor, while the timer clock remains paused.
		await page.clock.setSystemTime(time);
	};
}
