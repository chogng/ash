import { spawn, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

/** Test transport only: runs the real SDK program. Product routing is tested in Desktop. */
export async function startMarkdownParser() {
	const root = resolve(import.meta.dirname, '../../..');
	execFileSync('just', ['test', 'ash-markdown-parser', '--profile', 'ci-test', '--no-run', '--locked'], { cwd: root, timeout: 180000, stdio: 'pipe' });
	const binary = resolve(root, '.build/cargo/ci-test', `ash-markdown-parser${process.platform === 'win32' ? '.exe' : ''}`);
	const child = spawn(binary, [], { cwd: root, windowsHide: true, stdio: 'pipe' });
	let next = 0;
	const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; }>();
	const reader = createInterface({ input: child.stdout });
	reader.on('line', line => {
		const message = JSON.parse(line);
		const call = pending.get(message.requestId);
		if (!call) return;
		pending.delete(message.requestId); clearTimeout(call.timer);
		if (message.status === 'success') call.resolve(message.body);
		else call.reject(new Error(message.body?.message ?? 'Rust parse request failed'));
	});
	const fail = (error: Error) => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); } pending.clear(); };
	child.on('error', fail); child.on('exit', code => fail(new Error(`Markdown parser exited: ${code}`)));
	child.stderr.resume();
	const request = (method: string, params?: unknown): Promise<any> => new Promise((resolve, reject) => {
		const requestId = ++next;
		const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Markdown parser timed out')); }, 20000);
		pending.set(requestId, { resolve, reject, timer });
		child.stdin.write(JSON.stringify({ protocolVersion: 1, requestId, incarnation: 1, activationGeneration: 1, method, ...(params === undefined ? {} : { params }) }) + '\n');
	});
	try {
		await request('initialize', { extensionId: 'ash.markdown-parser', runtimeApiVersion: 1 });
		const activated = await request('activate', { extensionId: 'ash.markdown-parser', runtimeApiVersion: 1, package: { packageId: 'ash.markdown-parser@0.1.0', packageDigest: `sha256:${'a'.repeat(64)}`, entrypoint: 'ash-markdown-parser' }, activationEvents: ['onCommand:_markdown.parse'], capabilities: ['command'] });
		if (activated.result !== 'activated' || activated.body.registrations[0]?.command !== '_markdown.parse') throw new Error('Rust parser did not register');
	} catch (error) { child.kill(); reader.close(); throw error; }
	return {
		async parse(snapshot: unknown) {
			const response = await request('invoke', { extensionId: 'ash.markdown-parser', registrationId: '_markdown.parse', operation: 'execute', payload: { arguments: [snapshot] }, deadlineUnixMillis: Date.now() + 15000 });
			return response.body.payload;
		},
		async dispose() { try { await request('shutdown'); } finally { child.stdin.end(); child.kill(); reader.close(); } },
	};
}
