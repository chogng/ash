import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { AbstractDisposable, type IDisposable } from '../../../base/common/lifecycle.js';

export interface IDevelopmentAppServerRuntime extends IDisposable {
	readonly runtime: string;
	assertActive(): void;
}

/** Owns an OS lease through a Rust process whose stdin follows the Electron host lifetime. */
class DevelopmentAppServerRuntime extends AbstractDisposable implements IDevelopmentAppServerRuntime {
	constructor(readonly runtime: string, private readonly process: ChildProcessWithoutNullStreams) {
		super();
	}

	assertActive(): void {
		this.assertNotDisposed();
		if (this.process.exitCode !== null || this.process.signalCode !== null || this.process.stdin.destroyed) throw new Error('Development runtime lease process exited');
	}

	protected override disposeCore(): void {
		this.process.stdin.end();
	}
}

/** Rust holds publish.lock while reading current.json and acquiring the shared runtime lease. */
export async function acquireDevelopmentAppServerRuntime(executable: string, generationFile: string, environment: Readonly<Record<string, string>>): Promise<IDevelopmentAppServerRuntime> {
	const process = spawn(executable, ['lease-development', generationFile], { env: { ...environment }, shell: false, stdio: 'pipe', windowsHide: true });
	try {
		const runtime = await new Promise<string>((resolve, reject) => {
			let output = '';
			let errorOutput = '';
			const fail = (error: Error): void => { cleanup(); reject(error); };
			const onExit = (): void => fail(new Error(`Development runtime lease failed: ${errorOutput.trim()}`));
			const onErrorOutput = (chunk: Buffer): void => { errorOutput = (errorOutput + chunk.toString()).slice(-4_096); };
			const onOutput = (chunk: Buffer): void => {
				output += chunk.toString();
				if (Buffer.byteLength(output, 'utf8') > 32_768) { fail(new Error('Development runtime lease response is oversized')); return; }
				if (!output.includes('\n')) return;
				try {
					const value: unknown = JSON.parse(output);
					if (!value || typeof value !== 'object' || !('runtime' in value) || typeof value.runtime !== 'string' || !isAbsolute(value.runtime)) throw new Error('Invalid development runtime lease response');
					cleanup();
					resolve(resolvePath(value.runtime));
				} catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
			};
			function cleanup(): void {
				process.off('error', fail);
				process.off('exit', onExit);
				process.stdout.off('data', onOutput);
				process.stderr.off('data', onErrorOutput);
			}
			process.on('error', fail);
			process.on('exit', onExit);
			process.stdout.on('data', onOutput);
			process.stderr.on('data', onErrorOutput);
		});
		const lease = new DevelopmentAppServerRuntime(runtime, process);
		lease.assertActive();
		return lease;
	} catch (error) {
		process.stdin.end();
		process.kill();
		throw error;
	}
}
