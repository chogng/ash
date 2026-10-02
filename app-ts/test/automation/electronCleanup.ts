import type { ElectronApplication } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';

/** Owns shutdown of the test's Electron process before its private daemon. */
export function createElectronCleanup(application: ElectronApplication, stopDaemon: () => Promise<void>): () => Promise<void> {
	// The application channel can disappear before fixture teardown starts.
	const process = application.process();
	let closing: Promise<void> | undefined;
	return () => closing ??= close();

	async function close(): Promise<void> {
		const errors: unknown[] = [];
		const recordError = (error: unknown): void => { if (!errors.includes(error)) errors.push(error); };
		let onExit!: () => void;
		const exited = new Promise<void>(resolve => { onExit = resolve; });
		// Observe before issuing close: process exit can precede the close RPC's response.
		if (hasExited(process)) onExit();
		else process.once('exit', onExit);
		let stage = 'window shutdown';
		let timer!: ReturnType<typeof setTimeout>;
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`Electron cleanup exceeded 30000ms during ${stage}`)), 30_000);
		});
		try {
			// Page.close skips beforeunload and already handles a concurrently closed target.
			// Evaluating BrowserWindow.destroy through Main instead races the last-window quit.
			const pages = await Promise.allSettled(application.windows().map(page => Promise.race([page.close(), deadline])));
			for (const page of pages) if (page.status === 'rejected') recordError(page.reason);
			stage = 'application shutdown';
			// Still dispatch application.close if window shutdown exhausted the shared budget.
			try { await Promise.race([application.close(), deadline]); } catch (error) { recordError(error); }
			stage = 'process exit';
			try { await Promise.race([exited, deadline]); } catch (error) { recordError(error); }
		} finally {
			clearTimeout(timer);
			process.off('exit', onExit);
		}
		if (hasExited(process)) {
			if (process.exitCode !== 0 || process.signalCode !== null) {
				errors.push(new Error(`Electron exited abnormally (code ${process.exitCode}, signal ${process.signalCode})`));
			}
			// Only a confirmed exit makes it safe to stop the daemon without renderer reconnects.
			try { await stopDaemon(); } catch (error) { recordError(error); }
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, 'Electron cleanup failed');
	}
}

function hasExited(process: ChildProcess): boolean {
	return process.exitCode !== null || process.signalCode !== null;
}
