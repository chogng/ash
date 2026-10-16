import { execFileSync, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';

type ClientRequest = (request: any) => Promise<any>;
let built = false;

export function prepareMarkdownExtension(): void {
	if (built) return;
	execFileSync('just', ['test', 'ash-markdown-language-features', '-p', 'ash-markdown-math', '--profile', 'ci-test', '--no-run', '--locked'], { cwd: process.cwd(), timeout: 600000, stdio: 'pipe', windowsHide: true });
	built = true;
}

/** Runs the real Rust SDK process; tests supply only the initiating client's services. */
async function startExtensionProcess(binary: string, extensionId: string, capabilities: string[], language: string, documents: readonly any[], configuration: any, folders: readonly string[], clientRequest: ClientRequest) {
	const root = process.cwd();
	prepareMarkdownExtension();
	const executable = resolve(root, '.build/cargo/ci-test', `${binary}${process.platform === 'win32' ? '.exe' : ''}`);
	const child = spawn(executable, [], { cwd: root, windowsHide: true, stdio: 'pipe' });
	const reader = createInterface({ input: child.stdout });
	let sequence = 0;
	const clientCalls: string[] = [];
	const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; }>();
	const send = (message: any) => child.stdin.write(JSON.stringify(message) + '\n');
	reader.on('line', line => {
		void (async () => {
			const message = JSON.parse(line);
			if (message.callId !== undefined && message.operation) {
				const operation = message.operation;
				clientCalls.push(operation.operation);
				let result: any;
				try {
					if (operation.operation === 'listDocuments') result = { result: 'documents', documents };
					else if (operation.operation === 'readConfiguration') result = { result: 'configuration', value: operation.section.split('.').reduce((value: any, key: string) => value?.[key], configuration) ?? {} };
					else if (operation.operation === 'readDocument' && documents.some(document => document.uri === operation.uri)) result = { result: 'document', document: documents.find(document => document.uri === operation.uri) };
					else result = await clientRequest(operation);
					send({ context: message.context, callId: message.callId, outcome: { Ok: result } });
				} catch (error) {
					send({ context: message.context, callId: message.callId, outcome: { Err: { code: 'invalidRequest', message: String(error) } } });
				}
				return;
			}
			const call = pending.get(message.requestId);
			if (!call) return;
			pending.delete(message.requestId); clearTimeout(call.timer);
			if (message.status === 'success') call.resolve(message.body);
			else call.reject(new Error(message.body?.message ?? JSON.stringify(message)));
		})().catch(fail);
	});
	const fail = (error: Error) => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); } pending.clear(); };
	child.on('error', fail);
	child.on('exit', code => fail(new Error(`Markdown extension exited: ${code}`)));
	child.stderr.resume();
	const request = (method: string, params?: unknown, signal?: AbortSignal): Promise<any> => new Promise((resolve, reject) => {
		signal?.throwIfAborted();
		const requestId = ++sequence;
		const abort = () => {
			pending.delete(requestId); clearTimeout(timer);
			void request('cancel', { targetRequestId: requestId, reason: 'caller' }).catch(fail);
			reject(signal!.reason);
		};
		const cleanup = () => signal?.removeEventListener('abort', abort);
		const timer = setTimeout(() => { pending.delete(requestId); cleanup(); reject(new Error('Markdown extension timed out')); }, 30000);
		pending.set(requestId, { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); }, timer });
		signal?.addEventListener('abort', abort, { once: true });
		send({ protocolVersion: 1, requestId, incarnation: 1, activationGeneration: 1, method, ...(params === undefined ? {} : { params }) });
	});
	try {
		await request('initialize', { extensionId, runtimeApiVersion: 1 });
		const activation = await request('activate', {
			extensionId, runtimeApiVersion: 1,
			package: { packageId: `${extensionId}@1.0.0`, packageDigest: `sha256:${'a'.repeat(64)}`, entrypoint: binary },
			activationEvents: ['onStartupFinished'], capabilities,
			initialization: { language, workspaceFolders: folders.map((uri, index) => ({ uri, name: 'Workspace', index })), workspaceName: null, workspaceFile: null, configurationValues: configuration, configurationData: {} },
		});
		const registrations: any[] = activation.body.registrations;
		const invoke = async (registrationId: string, operation: string, payload: any, signal?: AbortSignal) => {
			signal?.throwIfAborted();
			if (operation === 'workspaceEvent' && payload.type === 'configuration') configuration = payload.configurationValues;
			const invocation = await request('invoke', { extensionId, registrationId, operation, payload, deadlineUnixMillis: Date.now() + 25000 }, signal);
			return invocation.body.payload;
		};
		return {
			registrations, invoke, clientCalls,
			async dispose() {
				try { await request('shutdown'); }
				finally { child.stdin.end(); child.kill(); reader.close(); fail(new Error('Markdown fixture closed')); }
			},
		};
	} catch (error) { child.kill(); reader.close(); fail(new Error('Markdown fixture startup failed')); throw error; }
}


/** Both implementations are real Rust programs; the fixture supplies their host route. */
export async function startMarkdownExtension(language = 'en', documents: readonly any[] = [], configuration: any = {}, folders: readonly string[] = [], clientRequest: ClientRequest = async () => ({ result: 'done' }), mathEnabled = true) {
	let math = mathEnabled ? await startExtensionProcess('ash-markdown-math', 'ash.markdown-math', ['dataChannel'], language, [], {}, [], clientRequest) : undefined;
	let runtime: Awaited<ReturnType<typeof startExtensionProcess>>;
	try {
		runtime = await startExtensionProcess('ash-markdown-language-features', 'ash.markdown-language-features', ['command', 'customTextEditor', 'languageProvider'], language, documents, configuration, folders, async operation => {
			if (operation.operation === 'backendRequest' && operation.capability === 'math.render.v2' && operation.method === 'receiveData') {
				if (!math) throw new Error('Math capability unavailable');
				return { result: 'value', value: await math.invoke('math.render.v2', 'receiveData', operation.params) };
			}
			return clientRequest(operation);
		});
	} catch (error) { await math?.dispose(); throw error; }
	const root = process.cwd();
	const invoke = runtime.invoke;
	return {
		...runtime,
		async parse(snapshot: any) { return (await invoke('vscode.markdown.editor', 'resolveCustomTextEditor', { document: { languageId: 'markdown', readOnly: false, ...snapshot } })).update; },
		async render(registrationId: string, payload: any) {
			const result = await invoke(registrationId, 'resolveCustomTextEditor', payload);
			if (result.resources) {
				const fixture = JSON.parse(await readFile(resolve(root, '.build/builtin/fixture.json'), 'utf8'));
				const resources = fixture.resources['ash.markdown-language-features'];
				result.html = `<style>${Buffer.from(resources[result.resources.style], 'base64').toString()}</style>${result.html}<script>${Buffer.from(resources[result.resources.script], 'base64').toString().replaceAll(/<\/script/gi, '<\\/script')}</script>`;
				delete result.resources;
			}
			return result;
		},
		async disableMath() { const current = math; math = undefined; await current?.dispose(); },
		async dispose() { try { await runtime.dispose(); } finally { await math?.dispose(); math = undefined; } },
	};
}

/** Exposes the same optional math process to chat-renderer consumers. */
export function startMarkdownMathExtension() {
	return startExtensionProcess('ash-markdown-math', 'ash.markdown-math', ['dataChannel'], 'en', [], {}, [], async () => ({ result: 'done' }));
}
