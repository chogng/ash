import { expect, test } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { attachRustGit } from '../../fixtures/browser/rustGitProcessFixture.js';

test('the Git fixture rejects pending requests and disposes after a signal exit', async ({ page }) => {
	const requestReceived = Promise.withResolvers<ChildProcessWithoutNullStreams>();
	const dispose = await attachRustGit(page, () => {
		const child = spawn(process.execPath, [
			'-e', "process.stdin.once('data', () => process.stderr.write('request received\\n')); process.stdin.resume();",
		], { stdio: ['pipe', 'pipe', 'pipe'] });
		child.stderr.once('data', () => requestReceived.resolve(child));
		child.once('error', requestReceived.reject);
		return child;
	});
	try {
		const activation = page.evaluate(() => (window as unknown as {
			__rustGitRequest(method: string, params: unknown): Promise<unknown>;
		}).__rustGitRequest('start', {}));
		const failed = expect(activation).rejects.toThrow(/Rust Git exited \(SIGTERM\)/);
		const child = await requestReceived.promise;
		expect(child.kill('SIGTERM')).toBe(true);
		await failed;
		expect(child.signalCode).toBe('SIGTERM');
	} finally {
		await dispose();
	}
});
