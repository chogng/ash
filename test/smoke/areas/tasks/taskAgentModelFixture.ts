import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export const taskModel = { provider: 'custom-task-regression', model: 'mock-task-agent' };
export const taskLabel = 'Mock Agent Loop';
export const taskMarker = 'ASH_MOCK_AGENT_TASK_READY';

interface InputItem {
	type?: string;
	role?: string;
	call_id?: string;
	name?: string;
	arguments?: string;
	output?: string | { text: string; }[];
}

/** The only mocked boundary: responses chosen from the real Agent's tool results. */
export class TaskAgentModelFixture {
	private readonly server: Server;
	private sequence = 0;
	private followupStart = 0;
	private directory: string | undefined;
	private runId: string | undefined;
	private expected: 'running' | 'denied' | 'failed' | 'revoked' | 'ready' | 'succeeded' = 'running';
	private selectedLabel = taskLabel;
	private pageSize: number | undefined;
	private referenceRead = false;
	readonly exchanges: { name?: string; arguments?: unknown; result?: unknown; answer?: string; }[] = [];
	readonly errors: string[] = [];

	constructor() {
		this.server = createServer(async (request, response) => {
			try {
				if (request.method === 'GET') {
					response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: taskModel.model }] }));
					return;
				}
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input: InputItem[]; };
				if (!this.directory) throw new Error('Task fixture directory has not been selected');
				if (this.sequence >= 256) throw new Error('Agent exceeded the bounded Task tool sequence');
				// Use the latest authored action, since Core sends earlier turns too.
				const action = body.input.filter(item => item.role === 'user').map(item => JSON.stringify(item).match(/TASK_FIXTURE_(RUN|CANCEL|RETRY|INSPECT)/)?.[1]).filter(Boolean).at(-1);
				const cancel = action === 'CANCEL';
				const inspect = action === 'INSPECT';
				if ((cancel || inspect || action === 'RETRY') && !this.followupStart) this.followupStart = this.sequence + 1;
				const latest = body.input.filter(item => item.type === 'function_call_output' && Number(item.call_id?.split('-').at(-1)) >= this.followupStart).at(-1);
				const call = latest && body.input.find(item => item.type === 'function_call' && item.call_id === latest.call_id);
				const text = latest && (typeof latest.output === 'string' ? latest.output : latest.output!.map(part => part.text).join(''));
				let result;
				if (text !== undefined) {
					try { result = JSON.parse(text); } catch { result = text; }
				}
				if (latest) this.exchanges.push({ name: call?.name, result });
				let name: string | undefined;
				let args: Record<string, unknown> | undefined;
				let answer: string | undefined;
				const next = (tool: string, arguments_: Record<string, unknown>): void => { name = tool; args = arguments_; };
				const target = (id = this.runId): Record<string, unknown> => {
					if (!id) throw new Error('Task result did not supply a Run ID');
					return { directory: this.directory, run_id: id };
				};
				if (!latest) {
					if (cancel) next('tasks_cancel', target());
					else if (inspect) next('tasks_status', target());
					else next('tasks_list', { directory: this.directory });
				} else if (call?.name === 'tasks_run' && (this.expected === 'denied' || this.expected === 'revoked') && typeof result === 'string') {
					// This is the actual Core error output, not an invented failed tool result.
					answer = 'TASK_REJECTED ' + result;
				} else {
					switch (call?.name) {
						case 'tasks_list': {
							const task = result.tasks.find((task: { label: string; }) => task.label === this.selectedLabel);
							if (!task?.revision || task.unavailableReason) throw new Error('Existing Task unavailable: ' + JSON.stringify(result));
							next('tasks_run', { directory: this.directory, task_id: task.taskId, revision: task.revision });
							break;
						}
						case 'tasks_run':
							this.runId = result.runId;
							next('tasks_status', target());
							break;
						case 'tasks_cancel':
							if (result.runId !== this.runId || result.status !== 'canceled') throw new Error('Cancellation did not affect the original Run');
							next('tasks_status', target());
							break;
						case 'tasks_status':
							if (result.runId !== this.runId) throw new Error('Status returned another Run');
							if ((result.status === 'failed' || result.status === 'canceled' || result.status === 'succeeded') && (this.expected === 'failed' || inspect)) {
								next('tasks_output', { ...target(), cursor: 0, max_characters: 65536 });
							} else if (!cancel && !inspect && this.expected === 'succeeded' && result.status === 'succeeded') {
								next('tasks_output', { ...target(), cursor: 0, max_characters: 65536 });
							} else if (result.status === 'failed' || result.status === 'succeeded') throw new Error('Fixture Task stopped unexpectedly: ' + JSON.stringify(result));
							else if ((!cancel && !inspect && (this.expected === 'running' || (this.expected === 'ready' && result.ready)) && result.status === 'running' && result.terminalId) || (cancel && result.status === 'canceled')) {
								next('tasks_output', { ...target(), cursor: 0, max_characters: 65536 });
							} else {
								// Back off while the real PTY is starting; do not spin model requests.
								await delay(150);
								next('tasks_status', target());
							}
							break;
						case 'tasks_output':
							if (this.pageSize && !cancel) {
								// Follow actual cursors and make one final empty read at EOF.
								if (!this.referenceRead) {
									this.referenceRead = true;
									next('tasks_output', { ...target(), cursor: 0, max_characters: this.pageSize });
								} else if (result.hasMore || result.text) next('tasks_output', { ...target(), cursor: result.nextCursor, max_characters: this.pageSize });
								else answer = 'OUTPUT_COMPLETE ' + this.runId;
							} else if (this.expected === 'succeeded') answer = 'SUCCEEDED ' + this.runId;
							else if (this.expected === 'failed') answer = 'FAILED ' + this.runId;
							else if (inspect) answer = 'STOPPED ' + this.runId;
							else if (result.text.includes(taskMarker)) answer = (cancel ? 'CANCELED ' : 'RUNNING ') + this.runId;
							else {
								await delay(150);
								next('tasks_output', { ...target(), cursor: 0, max_characters: 65536 });
							}
							break;
						default: throw new Error('Unexpected model tool result: ' + JSON.stringify(call));
					}
				}
				const id = 'mock-task-call-' + (++this.sequence);
				this.exchanges.push(answer ? { answer } : { name, arguments: args });
				const output = answer
					? [{ type: 'message', id, role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: answer }] }]
					: [{ type: 'function_call', id: 'item-' + id, call_id: id, name, arguments: JSON.stringify(args) }];
				response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end('event: response.completed\ndata: ' + JSON.stringify({
					type: 'response.completed', response: { id, status: 'completed', output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
				}) + '\n\n');
			} catch (error) {
				this.errors.push(String(error));
				response.writeHead(500).end(String(error));
			}
		});
	}

	async start(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			this.server.once('error', reject);
			this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
		});
	}

	get baseUrl(): string { return 'http://127.0.0.1:' + (this.server.address() as AddressInfo).port + '/v1'; }
	selectDirectory(directory: string): void { this.directory = directory; }
	expectOutcome(outcome: 'running' | 'denied' | 'failed' | 'revoked' | 'ready' | 'succeeded'): void { this.expected = outcome; }
	beginFollowup(): void { this.followupStart = this.sequence + 1; }
	selectTask(label: string): void { this.selectedLabel = label; }
	readPages(size: number): void { this.pageSize = size; }
	inspectRun(runId: string): void { this.runId = runId; this.beginFollowup(); }

	async close(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			this.server.close(error => error ? reject(error) : resolve());
			this.server.closeAllConnections();
		});
	}
}
