import { timeout } from '../../../../base/common/async.js';
import { CancellationError } from '../../../../base/common/errors.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { DebugExceptionsSnapshot, DebugBreakpointIntent, DebugInspection, DebugInspectionValue, DebugSessionInitializeOptions, IDebugAdapterProcessReadResult, IDebugAdapterProcessService, IDebugAdapterProcessStartOptions } from '../../../../platform/debug/common/debugAdapterProcessService.js';
import type { InlineDebugAdapter } from '../common/debug.js';

/** Workbench connection to one Rust-owned DAP client. Inline IO stays bound to
 * its extension instance; request IDs, pairing and deadlines use the same backend. */
export class RawDebugSession {
	private id: string | undefined;
	private closed = false;
	private inlineSequence = 0;
	private closing: Promise<void> | undefined;
	private readonly cancellations = new DisposableStore();

	constructor(private readonly processes: IDebugAdapterProcessService, private readonly inline?: InlineDebugAdapter) { }

	async start(options: IDebugAdapterProcessStartOptions): Promise<void> {
		if (this.closed) throw new CancellationError();
		try {
			const id = await this.processes.start(this.inline ? { arguments: [], connection: { type: 'client' }, ...(options.dirId === undefined ? {} : { dirId: options.dirId }) } : options);
			if (this.closed) {
				await this.processes.close(id);
				throw new CancellationError();
			}
			this.id = id;
		} catch (error) {
			await this.close().catch(() => { /* Preserve the startup error after attempting both releases. */ });
			throw error;
		}
	}

	initialize(options: DebugSessionInitializeOptions): Promise<void> { return this.processes.initializeSession(this.sessionId(), options); }

	configurationDone(exceptionFilters: readonly string[] | undefined): Promise<void> { return this.processes.completeConfiguration(this.sessionId(), exceptionFilters); }

	async setExceptionBreakpoints(filters: readonly string[]): Promise<DebugExceptionsSnapshot> {
		const id = this.sessionId();
		const version = await this.processes.setExceptionBreakpoints(id, filters);
		while (!this.closed) {
			const read = await this.processes.read(id, 0, 1);
			const state = read.exceptions;
			if (state && state.appliedVersion >= version) return state;
			if (state && state.version >= version && state.error) throw new Error(state.error);
			if (read.session?.phase === 'ended') throw new CancellationError();
			await timeout(40);
		}
		throw new CancellationError();
	}

	setBreakpoints(version: number, intents: readonly DebugBreakpointIntent[]): Promise<void> { return this.processes.setBreakpoints(this.sessionId(), version, intents); }
	readBreakpoints() { return this.processes.readBreakpoints(this.sessionId()); }

	async inspect(query: DebugInspection, inspectionRevision: number): Promise<DebugInspectionValue> {
		const id = this.sessionId();
		const inspectionId = await this.processes.startInspection(id, query, inspectionRevision);
		if (inspectionId === undefined) throw new CancellationError();
		while (!this.closed) {
			const result = await this.processes.readInspection(id, inspectionId);
			if (this.closed || result.state === 'invalidated') throw new CancellationError();
			if (result.state === 'complete') return result.value;
			if (result.state === 'failed') throw new Error(result.message);
			await timeout(40);
		}
		throw new CancellationError();
	}

	async request(command: string, args?: unknown, token?: CancellationToken, supportsCancel = false): Promise<unknown> {
		const id = this.sessionId();
		if (token?.isCancellationRequested) throw new CancellationError();
		const requestId = await this.processes.startRequest(id, command, args);
		if (this.closed) throw new CancellationError();
		let cancellation: IDisposable | undefined;
		const cancel = () => {
			if (cancellation && this.cancellations.delete(cancellation)) cancellation.dispose();
			if (supportsCancel && !this.closed) void this.request('cancel', { requestId }).catch(() => { /* Cancellation is advisory in DAP; the original response is still drained. */ });
		};
		if (token) cancellation = this.cancellations.add(token.onCancellationRequested(cancel));
		try {
			if (token?.isCancellationRequested) cancel();
			while (!this.closed) {
				const response = await this.processes.readResponse(id, requestId);
				if (this.closed) throw new CancellationError();
				if (response.state === 'complete') return response.response;
				if (response.state === 'failed') throw new Error(response.message);
				await timeout(40);
			}
			throw new CancellationError();
		} finally {
			if (cancellation && this.cancellations.delete(cancellation)) cancellation.dispose();
		}
	}

	send(message: unknown): Promise<void> { return this.processes.send(this.sessionId(), message); }

	async read(afterSequence: number, maxMessages: number): Promise<IDebugAdapterProcessReadResult> {
		const id = this.sessionId();
		if (this.inline) {
			const input = await this.inline.read(this.inlineSequence, 128);
			if (this.closed) throw new CancellationError();
			this.inlineSequence = input.nextSequence;
			if (input.messages.length || input.stderr || input.exited || input.outputGap || input.protocolError) await this.processes.acceptInput(id, input);
		}
		const read = await this.processes.read(id, afterSequence, maxMessages);
		if (this.closed) throw new CancellationError();
		if (read.outputGap) throw new Error('Debug Adapter output exceeded the retained buffer');
		if (this.inline) {
			for (const entry of read.messages) {
				if (entry.direction === 'outgoing' && read.session?.phase !== 'ended') await this.inline.send(entry.message);
			}
		}
		return read;
	}

	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.cancellations.dispose();
		const id = this.id;
		this.id = undefined;
		return this.closing = Promise.resolve().then(async () => {
			// Both owners must finish even if one side's close fails.
			const results = await Promise.allSettled([id ? this.processes.close(id) : Promise.resolve(), this.inline?.close()]);
			for (const result of results) if (result.status === 'rejected') throw result.reason;
		});
	}

	private sessionId(): string {
		if (this.closed || !this.id) throw new CancellationError();
		return this.id;
	}
}
