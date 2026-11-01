import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { withProcessRun } from '../../processes.ts';

// This process owns cleanup independently of both the debug launcher and the
// worker's event loop. The worker must not launch helpers before ownership is set.
const root = resolve(import.meta.dirname, '../../..');
let disconnected = !process.connected;
let cancel: (() => void) | undefined;
process.once('disconnect', () => { disconnected = true; cancel?.(); });

try {
	await withProcessRun(root, async (run, environment) => {
		cancel = () => { void run.stop('SIGTERM').catch(error => { console.error(error); process.exitCode = 1; }); };
		if (disconnected || run.stopped) return;
		const child = spawn(process.execPath, [resolve(root, 'build/desktop/launch/electron.ts'), ...process.argv.slice(2)], {
			cwd: root,
			env: { ...environment, ASH_ELECTRON_LAUNCH_WORKER: '1', ASH_DEV_PROCESS_SUPERVISED: '1' },
			stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
			detached: process.platform !== 'win32',
			windowsHide: true,
		});
		// Monitor the build/launch controller, not Electron: a product breakpoint
		// must not be mistaken for a hung worker.
		let lastHeartbeat = performance.now();
		let lastCheck = lastHeartbeat;
		let timedOut = false;
		child.on('message', message => {
			if (message === 'ash:dev:heartbeat') lastHeartbeat = performance.now();
		});
		const exited = new Promise<number>((resolveExit, reject) => {
			child.once('error', reject);
			child.once('exit', (code, signal) => resolveExit(signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : code ?? 1));
		});
		// Keep the rejection observed while the initial ownership snapshot yields.
		void exited.catch(() => { });
		let timer: ReturnType<typeof setInterval> | undefined;
		try {
			await run.own(child);
			if (run.stopped) return;
			child.send('ash:dev:start', error => { if (error) cancel?.(); });
			timer = setInterval(() => {
				const now = performance.now();
				// Sleep/resume or a paused supervisor delays both event loops. Give
				// the worker a fresh window rather than killing it on the first tick.
				if (now - lastCheck >= 30_000) lastHeartbeat = now;
				lastCheck = now;
				if (run.stopped || now - lastHeartbeat < 30_000) return;
				timedOut = true;
				console.error('[host] Development worker stopped responding; cleaning up its processes.');
				cancel?.();
			}, 1_000);
			const code = await exited;
			process.exitCode = timedOut ? 1 : code;
		} finally {
			clearInterval(timer);
		}
	}, { graceMs: 5_000 });
} finally {
	// A live parent IPC handle must not keep a completed supervisor alive.
	if (process.connected) process.disconnect();
}
