import { VSBuffer } from '../../../base/common/buffer.js';
import type { TerminalShellIntegrationEvent } from './terminal.js';
import type { ReplayEntry } from './terminalProcess.js';

export interface IRemoteTerminalProcessReplayEvent {
	events: ReplayEntry[];
}

/** Retains only display replay; process output and command history remain with the PTY owner. */
export class TerminalRecorder {
	private readonly segments: {
		cols: number;
		rows: number;
		chunks: { data: string; shellIntegration?: TerminalShellIntegrationEvent }[];
	}[];
	private bytes = 0;
	private chunks = 0;
	private truncated = false;
	get isTruncated(): boolean {
		return this.truncated;
	}

	constructor(
		cols: number,
		rows: number,
		private readonly limits = { maxBytes: 10 * 1024 * 1024, maxChunks: Infinity },
	) {
		this.segments = [{ cols, rows, chunks: [] }];
	}

	handleResize(cols: number, rows: number): void {
		const current = this.segments.at(-1)!;
		if (!current.chunks.length || (!current.cols && !current.rows)) {
			current.cols = cols;
			current.rows = rows;
		} else if (current.cols !== cols || current.rows !== rows) {
			this.segments.push({ cols, rows, chunks: [] });
		}
	}

	handleData(data: string, shellIntegration?: TerminalShellIntegrationEvent): void {
		if (!data && !shellIntegration) return;
		if (shellIntegration?.type === 'commandStorageDisabled' || (shellIntegration?.type === 'commandExecuted' && shellIntegration.commandStorageDisabled)) {
			for (const segment of this.segments)
				for (const chunk of segment.chunks) {
					const previous = chunk.shellIntegration;
					if (previous?.type === 'commandLine') chunk.shellIntegration = { ...previous, value: '', isTrusted: false };
					else if (previous?.type === 'commandExecuted')
						chunk.shellIntegration = {
							...previous,
							command: undefined,
							isTrusted: false,
							commandStorageDisabled: true,
						};
				}
			this.bytes = this.segments.reduce((sum, segment) => sum + segment.chunks.reduce((count, chunk) => count + chunkBytes(chunk), 0), 0);
		}
		let encoded = VSBuffer.fromString(data);
		if (encoded.byteLength > this.limits.maxBytes) {
			encoded = encoded.slice(-this.limits.maxBytes);
			// A UTF-8 prefix may have been cut. Retain a valid string so later
			// replay cannot join a dangling prefix with unrelated live output.
			data = encoded.toString();
			this.truncated = true;
		}
		const chunk = {
			data,
			...(shellIntegration === undefined ? {} : { shellIntegration: snapshotBoundary(shellIntegration) }),
		};
		this.segments.at(-1)!.chunks.push(chunk);
		this.bytes += chunkBytes(chunk);
		this.chunks++;
		while (this.bytes > this.limits.maxBytes || this.chunks > this.limits.maxChunks) {
			const first = this.segments[0]!;
			const removed = first.chunks.shift()!;
			this.bytes -= chunkBytes(removed);
			this.chunks--;
			this.truncated = true;
			if (!first.chunks.length && this.segments.length > 1) this.segments.shift();
		}
	}

	generateReplayEventSync(): IRemoteTerminalProcessReplayEvent {
		return {
			events: this.segments.flatMap(segment => {
				const events: ReplayEntry[] = [];
				for (const chunk of segment.chunks) {
					const previous = events.at(-1);
					if (previous && !previous.shellIntegration && !chunk.shellIntegration) previous.data += chunk.data;
					else
						events.push({
							cols: segment.cols,
							rows: segment.rows,
							data: chunk.data,
							...(chunk.shellIntegration ? { shellIntegration: snapshotBoundary(chunk.shellIntegration) } : {}),
						});
				}
				return events.length ? events : [{ cols: segment.cols, rows: segment.rows, data: '' }];
			}),
		};
	}

	async generateReplayEvent(): Promise<IRemoteTerminalProcessReplayEvent> {
		return this.generateReplayEventSync();
	}
}

function chunkBytes(chunk: { data: string; shellIntegration?: TerminalShellIntegrationEvent }): number {
	return VSBuffer.fromString(chunk.data).byteLength + (chunk.shellIntegration ? VSBuffer.fromString(JSON.stringify(chunk.shellIntegration)).byteLength : 0);
}

function snapshotBoundary(event: TerminalShellIntegrationEvent): TerminalShellIntegrationEvent {
	return event.type === 'environment' ? { ...event, values: event.values && { ...event.values } } : { ...event };
}
