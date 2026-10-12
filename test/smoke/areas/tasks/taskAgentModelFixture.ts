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
	private cancelStart = 0;
	private directory: string | undefined;
	private runId: string | undefined;
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
				// Core adds context after the authored prompt; inspect all user entries.
				const cancel = body.input.some(item => item.role === 'user' && JSON.stringify(item).includes('TASK_FIXTURE_CANCEL'));
				if (cancel && !this.cancelStart) this.cancelStart = this.sequence + 1;
				const latest = body.input.filter(item => item.type === 'function_call_output' && (!cancel || Number(item.call_id?.split('-').at(-1)) >= this.cancelStart)).at(-1);
				const call = latest && body.input.find(item => item.type === 'function_call' && item.call_id === latest.call_id);
				const result = latest ? JSON.parse(typeof latest.output === 'string' ? latest.output : latest.output!.map(part => part.text).join('')) : undefined;
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
					else next('tasks_list', { directory: this.directory });
				} else {
					switch (call?.name) {
						case 'tasks_list': {
							const task = result.tasks.find((task: { label: string; }) => task.label === taskLabel);
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
							if (result.status === 'failed' || result.status === 'completed') throw new Error('Fixture Task stopped unexpectedly: ' + JSON.stringify(result));
							if ((!cancel && result.status === 'running' && result.terminalId) || (cancel && result.status === 'canceled')) {
								next('tasks_output', { ...target(), cursor: 0, max_characters: 65536 });
							} else {
								// Back off while the real PTY is starting; do not spin model requests.
								await delay(150);
								next('tasks_status', target());
							}
							break;
						case 'tasks_output':
							if (result.text.includes(taskMarker)) answer = (cancel ? 'CANCELED ' : 'RUNNING ') + this.runId;
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

	async close(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			this.server.close(error => error ? reject(error) : resolve());
			this.server.closeAllConnections();
		});
	}
}
