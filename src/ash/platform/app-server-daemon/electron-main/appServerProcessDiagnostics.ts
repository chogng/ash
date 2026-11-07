import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, copyFile, mkdtemp, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { BrowserWindow } from 'electron';
import { DeferredPromise } from '../../../base/common/async.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { removeAnsiEscapeCodes } from '../../../base/common/strings.js';
import { localize } from '../../../nls.js';
import type { LocalAppServerDiagnosticOperation } from '../../agentHost/common/appServerTransport.js';
import type { IDialogMainService } from '../../dialogs/electron-main/dialogMainService.js';
import type { AppServerDaemonLauncher } from './appServerDaemonLauncher.js';

interface Recording {
	readonly directory: string;
	readonly file: string;
	readonly helper: ChildProcessWithoutNullStreams;
	readonly finished: Promise<Error | undefined>;
}

/** Owns a single CPU recording for the local Desktop profile across all windows. */
export class AppServerProcessDiagnostics extends Disposable {
	private recording: Recording | undefined;
	private changing = false;

	async run(operation: LocalAppServerDiagnosticOperation, launcher: AppServerDaemonLauncher, save: IDialogMainService['showSaveDialog'], window: BrowserWindow): Promise<void> {
		this.assertNotDisposed();
		if (operation === 'debug') {
			await openDebugger(() => launcher.diagnosticPid());
			return;
		}
		if (this.changing) {
			throw new Error(localize('chat.developer.profileBusy', 'A CPU recording operation is already in progress.'));
		}
		this.changing = true;
		try {
			if (operation === 'startProfile') {
				await this.start(launcher);
			} else {
				await this.stop(save, window);
			}
		} finally {
			this.changing = false;
		}
	}

	private async start(launcher: AppServerDaemonLauncher): Promise<void> {
		if (this.recording) {
			throw new Error(localize('chat.developer.profileAlreadyRunning', 'Stop the current CPU recording before starting another.'));
		}
		const profiler = await findExecutable(process.platform === 'win32' ? ['samply.exe'] : ['samply']);
		if (!profiler) {
			throw new Error(localize('chat.developer.profilerMissing', 'Install Samply and make it available on the Desktop PATH to record App Server CPU samples.'));
		}
		const directory = await mkdtemp(join(tmpdir(), 'ash-app-server-profile-'));
		const file = join(directory, 'app-server-profile.json');
		let recording: Recording | undefined;
		try {
			await launcher.validate();
			this.assertNotDisposed();
			const helper = launcher.launchProfiler(profiler, file);
			const { ready, finished } = observeProfiler(helper);
			recording = { directory, file, helper, finished };
			this.recording = recording;
			await ready;
			this.assertNotDisposed();
		} catch (error) {
			recording?.helper.stdin.destroy();
			await recording?.finished;
			if (this.recording === recording) {
				this.recording = undefined;
			}
			await removeTemporaryDirectory(directory);
			throw error;
		}
	}

	private async stop(save: IDialogMainService['showSaveDialog'], window: BrowserWindow): Promise<void> {
		const recording = this.recording;
		if (!recording) {
			throw new Error(localize('chat.developer.profileNotRunning', 'There is no App Server CPU recording to stop.'));
		}
		if (!recording.helper.stdin.writableEnded) {
			recording.helper.stdin.end('S');
		}
		const error = await recording.finished;
		if (error) {
			this.recording = undefined;
			await removeTemporaryDirectory(recording.directory);
			throw error;
		}
		const result = await save({
			title: localize('chat.developer.saveCpuProfile', 'Save App Server CPU Profile'),
			defaultPath: 'app-server-profile.json',
			filters: [{ name: localize('chat.developer.cpuProfileFilter', 'Firefox Profiler JSON'), extensions: ['json'] }],
		}, window);
		if (!result.canceled) {
			if (!isAbsolute(result.filePath)) {
				throw new Error(localize('chat.developer.profileDestinationInvalid', 'Select an absolute local path for the CPU profile.'));
			}
			// Keep the original report available for retry if writing the destination fails.
			const staging = await mkdtemp(join(dirname(result.filePath), '.ash-profile-'));
			try {
				const file = join(staging, 'profile.json');
				await copyFile(recording.file, file);
				await rename(file, result.filePath);
			} finally {
				await removeTemporaryDirectory(staging);
			}
		}
		this.recording = undefined;
		await removeTemporaryDirectory(recording.directory);
	}

	override dispose(): void {
		const recording = this.recording;
		this.recording = undefined;
		if (recording) {
			recording.helper.stdin.destroy();
			void recording.finished.then(() => removeTemporaryDirectory(recording.directory));
		}
		super.dispose();
	}
}

function observeProfiler(child: ChildProcessWithoutNullStreams): { ready: Promise<void>; finished: Promise<Error | undefined>; } {
	const ready = new DeferredPromise<void>();
	let response = '';
	let diagnostic = '';
	child.stdin.on('error', () => { /* The helper exit owns the result. */ });
	child.stdout.on('data', (data: Buffer) => {
		if (ready.isSettled) { return; }
		response += data.toString('utf8');
		if (response === 'ready\n' || response === 'ready\r\n') {
			void ready.complete();
		} else if (response.length > 7) {
			child.stdin.destroy();
			void ready.error(new Error(localize('chat.developer.profileInvalid', 'The CPU recorder sent an invalid startup response.')));
		}
	});
	child.stderr.on('data', (data: Buffer) => { diagnostic = (diagnostic + data.toString('utf8')).slice(-2048); });
	const finished = new Promise<Error | undefined>(resolve => {
		child.once('error', error => {
			void ready.error(error);
			resolve(error);
		});
		child.once('close', code => {
			const error = code === 0 && ready.isResolved ? undefined : new Error(localize('chat.developer.profileFailed', 'App Server CPU recording failed. {0}', removeAnsiEscapeCodes(diagnostic).trim()));
			if (error) { void ready.error(error); }
			resolve(error);
		});
	});
	return { ready: ready.p, finished };
}

async function openDebugger(resolvePid: () => Promise<number>): Promise<void> {
	if (process.platform === 'darwin') {
		const script = [
			'on run argv',
			'tell application "Terminal" to do script ("/usr/bin/lldb --no-lldbinit --attach-pid " & quoted form of item 1 of argv)',
			'tell application "Terminal" to activate',
			'end run',
		].join('\n');
		await promisify(execFile)('/usr/bin/osascript', ['-e', script, String(await resolvePid())], { timeout: 15_000 });
		return;
	}
	if (process.platform === 'win32') {
		const debuggerPath = await findExecutable(['windbg.exe', 'WinDbgX.exe']);
		if (!debuggerPath) {
			throw new Error(localize('chat.developer.winDbgMissing', 'Install WinDbg and make it available on the Desktop PATH to attach to the App Server.'));
		}
		const args = debuggerPath.toLowerCase().endsWith('windbg.exe') ? ['-pd', '-g'] : ['-g'];
		await launchDebugger(debuggerPath, [...args, '-p', String(await resolvePid())]);
		return;
	}
	const terminal = await findExecutable(['x-terminal-emulator', 'xterm']);
	const debuggerPath = await findExecutable(['lldb']);
	if (!terminal || !debuggerPath) {
		throw new Error(localize('chat.developer.lldbMissing', 'Install LLDB and x-terminal-emulator or xterm to attach to the App Server.'));
	}
	await launchDebugger(terminal, ['-e', debuggerPath, '--no-lldbinit', '--attach-pid', String(await resolvePid())]);
}

function launchDebugger(executable: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, { detached: true, stdio: 'ignore', cwd: tmpdir() });
		child.once('error', reject);
		child.once('spawn', () => { child.unref(); resolve(); });
	});
}

async function findExecutable(names: string[]): Promise<string | undefined> {
	for (const directory of process.env.PATH?.split(delimiter) ?? []) {
		if (!isAbsolute(directory)) { continue; }
		for (const name of names) {
			const candidate = join(directory, name);
			try {
				await access(candidate, constants.X_OK);
				return candidate;
			} catch { /* Check the next installation directory. */ }
		}
	}
	return undefined;
}

function removeTemporaryDirectory(directory: string): Promise<void> {
	return rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => { /* Best-effort cleanup after the operation. */ });
}
