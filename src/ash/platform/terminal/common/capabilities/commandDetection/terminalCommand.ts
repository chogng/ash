import { generateUuid } from '../../../../../base/common/uuid.js';
import type { ITerminalCommandScreen, ITerminalOutputMatch, ITerminalOutputMatcher } from '../../terminal.js';
import type { IMarkProperties, ISerializedTerminalCommand, ITerminalCommand } from '../capabilities.js';

type Marker = NonNullable<IMarkProperties['marker']>;

export interface ITerminalCommandProperties {
	command: string;
	commandLineConfidence: 'low' | 'medium' | 'high';
	isTrusted: boolean;
	timestamp: number;
	duration: number;
	id: string | undefined;
	marker: Marker | undefined;
	cwd: string | undefined;
	exitCode: number | undefined;
	commandStartLineContent: string | undefined;
	markProperties: IMarkProperties | undefined;
	executedX: number | undefined;
	startX: number | undefined;
	promptStartMarker?: Marker;
	endMarker?: Marker;
	executedMarker?: Marker;
	aliases?: string[][];
	wasReplayed?: boolean;
}

/** Screen-local command positions. Rust owns the process history; these markers own no process. */
export class TerminalCommand implements ITerminalCommand {
	command!: string;
	commandLineConfidence!: 'low' | 'medium' | 'high';
	isTrusted!: boolean;
	timestamp!: number;
	duration!: number;
	id!: string | undefined;
	readonly marker!: Marker | undefined;
	cwd!: string | undefined;
	exitCode!: number | undefined;
	commandStartLineContent!: string | undefined;
	readonly markProperties!: IMarkProperties | undefined;
	executedX!: number | undefined;
	readonly startX!: number | undefined;
	readonly promptStartMarker?: Marker;
	private end: Marker | undefined;
	private endColumn = 0;
	get endMarker(): Marker | undefined {
		return this.end;
	}
	set endMarker(value: Marker | undefined) {
		this.end = value;
		this.endColumn = this.terminal.buffer.normal.cursorX;
	}
	executedMarker?: Marker;
	readonly aliases?: string[][];
	readonly wasReplayed?: boolean;

	constructor(
		private readonly terminal: ITerminalCommandScreen,
		properties: ITerminalCommandProperties,
	) {
		Object.assign(this, properties);
		if (properties.wasReplayed) {
			this.endColumn = 0;
		}
	}

	extractCommandLine(): string {
		if (!this.marker || this.marker.isDisposed || !this.executedMarker || this.executedMarker.isDisposed) {
			return this.command;
		}
		return readBufferRange(this.terminal, this.marker.line, this.startX ?? 0, this.executedMarker.line, this.executedX ?? 0).replace(/\n$/, '');
	}

	getOutput(): string | undefined {
		if (!this.executedMarker || !this.endMarker || this.executedMarker.isDisposed || this.endMarker.isDisposed) {
			return undefined;
		}
		return readBufferRange(this.terminal, this.executedMarker.line, this.executedX ?? 0, this.endMarker.line, this.endColumn).replace(/\n$/, '');
	}

	hasOutput(): boolean {
		return Boolean(this.getOutput());
	}

	getOutputMatch(matcher: ITerminalOutputMatcher): ITerminalOutputMatch | undefined {
		const output = this.getOutput();
		if (output === undefined) {
			return undefined;
		}
		const lines = output.split('\n');
		const length = Math.max(1, Math.min(40, Math.floor(matcher.length)));
		const offset = Math.max(0, Math.floor(matcher.offset));
		const start = matcher.anchor === 'top' ? offset : Math.max(0, lines.length - offset - length);
		const selected = lines.slice(start, matcher.anchor === 'top' ? start + length : lines.length - offset);
		const expression =
			typeof matcher.lineMatcher === 'string'
				? new RegExp(matcher.lineMatcher.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
				: new RegExp(matcher.lineMatcher.source, matcher.lineMatcher.flags.replace(/[gy]/g, ''));
		if (expression.multiline || expression.source.includes('\\n')) {
			const regexMatch = selected.join('\n').match(expression);
			return regexMatch ? { regexMatch, outputLines: selected } : undefined;
		}
		for (const line of selected) {
			const regexMatch = line.match(expression);
			if (regexMatch) {
				return { regexMatch, outputLines: matcher.multipleMatches ? selected : [line] };
			}
		}
		return undefined;
	}

	getPromptRowCount(): number {
		return this.promptStartMarker && this.marker ? Math.max(1, this.marker.line - this.promptStartMarker.line + 1) : 1;
	}

	getCommandRowCount(): number {
		return this.marker && this.executedMarker ? Math.max(1, this.executedMarker.line - this.marker.line + (this.executedX ? 1 : 0)) : 1;
	}

	serialize(isCommandStorageDisabled: boolean): ISerializedTerminalCommand {
		return {
			command: isCommandStorageDisabled ? '' : this.command,
			commandLineConfidence: isCommandStorageDisabled ? 'low' : this.commandLineConfidence,
			isTrusted: !isCommandStorageDisabled && this.isTrusted,
			timestamp: this.timestamp,
			duration: this.duration,
			id: this.id,
			cwd: this.cwd,
			exitCode: this.exitCode,
			commandStartLineContent: isCommandStorageDisabled ? undefined : this.commandStartLineContent,
			markProperties: this.markProperties && { ...this.markProperties, marker: undefined },
			startX: this.startX,
			executedX: this.executedX,
			startLine: liveLine(this.marker),
			promptStartLine: liveLine(this.promptStartMarker),
			executedLine: liveLine(this.executedMarker),
			endLine: liveLine(this.endMarker),
		};
	}

	static deserialize(terminal: ITerminalCommandScreen, value: ISerializedTerminalCommand, disabled: boolean): TerminalCommand | undefined {
		const buffer = terminal.buffer.normal;
		const marker = (line: number | undefined): Marker | undefined =>
			line !== undefined && line >= 0 && line < buffer.length ? terminal.registerMarker(line - buffer.baseY - buffer.cursorY) : undefined;
		const start = marker(value.startLine);
		if (!start) {
			return undefined;
		}
		return new TerminalCommand(terminal, {
			...value,
			command: disabled ? '' : value.command,
			isTrusted: !disabled && value.isTrusted,
			marker: start,
			promptStartMarker: marker(value.promptStartLine),
			executedMarker: marker(value.executedLine),
			endMarker: marker(value.endLine),
			wasReplayed: true,
		});
	}
}

function liveLine(marker: Marker | undefined): number | undefined {
	return marker?.isDisposed ? undefined : marker?.line;
}

/** Reads cell ranges while joining physical wraps and preserving intentional line breaks. */
export function readBufferRange(terminal: ITerminalCommandScreen, startLine: number, startX: number, endLine: number, endX: number): string {
	const buffer = terminal.buffer.normal;
	const result: string[] = [];
	for (let line = Math.max(0, startLine); line <= Math.min(buffer.length - 1, endLine); line++) {
		const row = buffer.getLine(line);
		if (!row) {
			continue;
		}
		if (line > startLine && !row.isWrapped) {
			result.push('\n');
		}
		result.push(row.translateToString(true, line === startLine ? startX : 0, line === endLine ? endX : terminal.cols));
	}
	return result.join('');
}

export interface ICurrentPartialCommand {
	promptStartMarker?: Marker;
	commandStartMarker?: Marker;
	commandStartX?: number;
	commandStartLineContent?: string;
	commandRightPromptStartX?: number;
	commandRightPromptEndX?: number;
	commandLines?: Marker;
	commandExecutedMarker?: Marker;
	commandExecutedX?: number;
	commandFinishedMarker?: Marker;
	currentContinuationMarker?: Marker;
	continuations?: { marker: Marker; end: number }[];
	command?: string;
	isTrusted?: boolean;
	isInvalid?: boolean;
	getPromptRowCount(): number;
	getCommandRowCount(): number;
}

/** A prompt under construction. Its lifetime is owned by the command detection capability. */
export class PartialTerminalCommand implements ICurrentPartialCommand {
	promptStartMarker?: Marker;
	commandStartMarker?: Marker;
	commandStartX?: number;
	commandStartLineContent?: string;
	commandRightPromptStartX?: number;
	commandRightPromptEndX?: number;
	commandLines?: Marker;
	commandExecutedMarker?: Marker;
	commandExecutedX?: number;
	commandFinishedMarker?: Marker;
	currentContinuationMarker?: Marker;
	continuations?: { marker: Marker; end: number }[];
	command?: string;
	isTrusted?: boolean;
	isInvalid?: boolean;
	readonly id: string;
	private started = 0;
	private elapsed = 0;

	constructor(
		private readonly terminal: ITerminalCommandScreen,
		id?: string,
	) {
		this.id = id ?? generateUuid();
	}

	markExecutedTime(): void {
		this.started = Date.now();
	}
	markFinishedTime(): void {
		this.elapsed = this.started ? Math.max(0, Date.now() - this.started) : 0;
	}
	getPromptRowCount(): number {
		return this.promptStartMarker && this.commandStartMarker ? Math.max(1, this.commandStartMarker.line - this.promptStartMarker.line + 1) : 1;
	}
	getCommandRowCount(): number {
		return this.commandStartMarker && this.commandExecutedMarker ? Math.max(1, this.commandExecutedMarker.line - this.commandStartMarker.line + (this.commandExecutedX ? 1 : 0)) : 1;
	}

	promoteToFullCommand(cwd: string | undefined, exitCode: number | undefined, ignoreCommandLine: boolean, markProperties: IMarkProperties | undefined): TerminalCommand | undefined {
		if (!this.commandStartMarker || this.commandStartMarker.isDisposed || this.isInvalid || (!this.command && !ignoreCommandLine)) {
			return undefined;
		}
		return new TerminalCommand(this.terminal, {
			command: this.command ?? '',
			commandLineConfidence: this.command === undefined ? 'low' : this.isTrusted ? 'high' : 'medium',
			isTrusted: this.isTrusted === true,
			timestamp: this.started,
			duration: this.elapsed,
			id: this.id,
			marker: this.commandStartMarker,
			promptStartMarker: this.promptStartMarker,
			executedMarker: this.commandExecutedMarker,
			endMarker: this.commandFinishedMarker,
			startX: this.commandStartX,
			executedX: this.commandExecutedX,
			cwd,
			exitCode,
			commandStartLineContent: this.commandStartLineContent,
			markProperties,
		});
	}

	serialize(cwd: string | undefined): ISerializedTerminalCommand | undefined {
		return this.promoteToFullCommand(cwd, undefined, true, undefined)?.serialize(false);
	}
}

export function isFullTerminalCommand(command: ITerminalCommand | ICurrentPartialCommand): command is ITerminalCommand {
	return 'getOutput' in command;
}
