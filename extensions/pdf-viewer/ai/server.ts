import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Worker } from 'node:worker_threads';
import { parseRequest, pdfTools, type PdfReadRequest } from './requests.js';
import type { ReadingResult } from './reader.js';
import { prepareNativeCanvas } from './nativeCanvas.js';

const cleanupNative = prepareNativeCanvas();
process.once('exit', cleanupNative);
const workers = new Set<Worker>();
let closing = false;
const server = new Server({ name: 'ash-pdf-reading', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: pdfTools }));
server.setRequestHandler(CallToolRequestSchema, async (call, extra) => {
	try {
		if (closing) throw new Error('PDF reader is closing');
		const request = parseRequest(call.params.name, call.params.arguments);
		if (workers.size >= 2) throw new Error('PDF reader is busy; retry after the current read completes');
		const result = await run(request, extra.signal);
		return { content: result.content };
	} catch (error) {
		return {
			isError: true,
			content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
		};
	}
});

/** Termination also interrupts synchronous parsing/rendering, which AbortSignal alone cannot stop. */
function run(request: PdfReadRequest, signal: AbortSignal): Promise<ReadingResult> {
	if (signal.aborted) return Promise.reject(new Error('PDF reading cancelled'));
	const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
		workerData: request,
		resourceLimits: { maxOldGenerationSizeMb: 256 },
		stdout: true,
		stderr: true,
	});
	workers.add(worker);
	// PDF.js or native diagnostics must never corrupt the MCP stdout transport.
	worker.stdout.resume();
	worker.stderr.resume();
	return new Promise<ReadingResult>((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error, result?: ReadingResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener('abort', abort);
			void worker.terminate().finally(() => {
				workers.delete(worker);
				error ? reject(error) : resolve(result!);
			});
		};
		const abort = (): void => finish(new Error('PDF reading cancelled'));
		const timer = setTimeout(() => finish(new Error('PDF reading exceeded its 30-second time budget')), 30000);
		signal.addEventListener('abort', abort, { once: true });
		worker.once('message', (message: { result?: ReadingResult; error?: string }) => finish(message.error ? new Error(message.error) : undefined, message.result));
		worker.once('error', error => finish(error));
		worker.once('exit', code => {
			if (!settled) finish(new Error(`PDF worker exited before returning a result (${code})`));
		});
	});
}

async function close(): Promise<void> {
	if (closing) return;
	closing = true;
	await Promise.all([...workers].map(worker => worker.terminate()));
	await server.close();
	cleanupNative();
}
process.once('SIGTERM', () => {
	void close();
});
process.once('SIGINT', () => {
	void close();
});
process.stdin.once('end', () => {
	void close();
});
await server.connect(new StdioServerTransport());
