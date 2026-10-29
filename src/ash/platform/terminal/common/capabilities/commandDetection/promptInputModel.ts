import { Emitter, type Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import type { ILogService } from '../../../../log/common/log.js';
import {
	GeneralShellType,
	PosixShellType,
	type ITerminalCommandScreen,
	type TerminalShellType,
} from '../../terminal.js';
import type { ITerminalCommand } from '../capabilities.js';

export const enum PromptInputState {
	Unknown = 0,
	Input = 1,
	Execute = 2,
}

export interface IPromptInputModelState {
	readonly value: string;
	readonly prefix: string;
	readonly suffix: string;
	readonly cursorIndex: number;
	readonly ghostTextIndex: number;
}

export interface IPromptInputModel extends IPromptInputModelState {
	readonly state: PromptInputState;
	readonly onDidStartInput: Event<IPromptInputModelState>;
	readonly onDidChangeInput: Event<IPromptInputModelState>;
	readonly onDidFinishInput: Event<IPromptInputModelState>;
	readonly onDidInterrupt: Event<IPromptInputModelState>;
	getCombinedString(emptyStringWhenEmpty?: boolean): string;
	setShellType(value?: TerminalShellType): void;
}

export interface ISerializedPromptInputModel {
	readonly modelState: IPromptInputModelState;
	readonly commandStartX: number;
	readonly lastPromptLine: string | undefined;
	readonly continuationPrompt: string | undefined;
	readonly lastUserInput: string;
}

/** Observes parsed cells; keystrokes are never interpreted as edits to the shell's input buffer. */
export class PromptInputModel extends Disposable implements IPromptInputModel {
	private inputState = PromptInputState.Unknown;
	private text = '';
	private cursor = -1;
	private ghost = -1;
	private origin: ITerminalCommand['marker'];
	private startX = 0;
	private lastLine = 0;
	private continuation: string | undefined;
	private lastPrompt: string | undefined;
	private rightPrompt: { start: number; end: number } | undefined;
	private lastUserInput = '';
	private shell: TerminalShellType;
	private readonly started = this._register(new Emitter<IPromptInputModelState>());
	private readonly changed = this._register(new Emitter<IPromptInputModelState>());
	private readonly finished = this._register(new Emitter<IPromptInputModelState>());
	private readonly interrupted = this._register(new Emitter<IPromptInputModelState>());
	readonly onDidStartInput = this.started.event;
	readonly onDidChangeInput = this.changed.event;
	readonly onDidFinishInput = this.finished.event;
	readonly onDidInterrupt = this.interrupted.event;
	get state(): PromptInputState {
		return this.inputState;
	}
	get value(): string {
		return this.text;
	}
	get cursorIndex(): number {
		return this.cursor;
	}
	get ghostTextIndex(): number {
		return this.ghost;
	}
	get prefix(): string {
		return this.cursor < 0 ? '' : this.text.slice(0, this.cursor);
	}
	get suffix(): string {
		return this.cursor < 0 ? '' : this.text.slice(this.cursor, this.ghost < 0 ? undefined : this.ghost);
	}

	constructor(
		private readonly terminal: ITerminalCommandScreen,
		onCommandStart: Event<ITerminalCommand>,
		onCommandStartChanged: Event<void>,
		onCommandExecuted: Event<ITerminalCommand>,
		onCommandFinished: Event<ITerminalCommand>,
		private readonly log: ILogService,
	) {
		super();
		this._register(
			onCommandStart(command => {
				this.origin = command.marker;
				this.startX = command.startX ?? terminal.buffer.normal.cursorX;
				this.lastLine = this.origin?.line ?? 0;
				this.rightPrompt = undefined;
				this.text = '';
				this.cursor = 0;
				this.ghost = -1;
				this.inputState = PromptInputState.Input;
				this.started.fire(this.snapshot());
				this.sync();
			}),
		);
		this._register(onCommandStartChanged(() => this.sync()));
		this._register(onCommandExecuted(() => this.finish(PromptInputState.Execute)));
		this._register(
			onCommandFinished(() => {
				this.inputState = PromptInputState.Unknown;
				this.origin = undefined;
			}),
		);
		const parsed = terminal.onWriteParsed(() => this.sync());
		const cursor = terminal.onCursorMove(() => this.sync());
		const input = terminal.onData(value => {
			this.lastUserInput = value;
			if (value.includes('\x03') && this.inputState === PromptInputState.Input) {
				this.sync();
				this.interrupted.fire(this.snapshot());
				this.finish(PromptInputState.Unknown);
			}
		});
		this._register(toDisposable(() => parsed.dispose()));
		this._register(toDisposable(() => cursor.dispose()));
		this._register(toDisposable(() => input.dispose()));
	}

	reset(): void {
		this.inputState = PromptInputState.Unknown;
		this.origin = undefined;
		this.rightPrompt = undefined;
		this.continuation = undefined;
		this.lastPrompt = undefined;
		this.lastUserInput = '';
		this.text = '';
		this.cursor = -1;
		this.ghost = -1;
		this.changed.fire(this.snapshot());
	}

	setShellType(value?: TerminalShellType): void {
		this.shell = value;
		this.sync();
	}
	setContinuationPrompt(value: string): void {
		this.continuation = value;
		this.sync();
	}
	setLastPromptLine(value: string): void {
		this.lastPrompt = value;
		this.sync();
	}
	setRightPromptRange(start: number, end: number): void {
		this.rightPrompt = { start, end };
		this.sync();
	}

	setConfidentCommandLine(value: string): void {
		this.text = value;
		this.cursor = value.length;
		this.ghost = -1;
		this.changed.fire(this.snapshot());
	}

	getCombinedString(emptyStringWhenEmpty = false): string {
		if (emptyStringWhenEmpty && !this.text) {
			return '';
		}
		let text = this.text;
		if (this.ghost >= 0) {
			text = text.slice(0, this.ghost) + '[' + text.slice(this.ghost) + ']';
		}
		return this.cursor < 0 ? text : text.slice(0, this.cursor) + '|' + text.slice(this.cursor);
	}

	serialize(): ISerializedPromptInputModel {
		return {
			modelState: this.snapshot(),
			commandStartX: this.startX,
			lastPromptLine: this.lastPrompt,
			continuationPrompt: this.continuation,
			lastUserInput: this.lastUserInput,
		};
	}

	deserialize(value: ISerializedPromptInputModel): void {
		this.text = value.modelState.value;
		this.cursor = value.modelState.cursorIndex;
		this.ghost = value.modelState.ghostTextIndex;
		this.startX = value.commandStartX;
		this.continuation = value.continuationPrompt;
		this.lastPrompt = value.lastPromptLine;
		this.lastUserInput = value.lastUserInput;
		if (!this.origin || this.origin.isDisposed) {
			this.inputState = PromptInputState.Unknown;
		}
		this.changed.fire(this.snapshot());
	}

	private snapshot(): IPromptInputModelState {
		return {
			value: this.text,
			prefix: this.prefix,
			suffix: this.suffix,
			cursorIndex: this.cursor,
			ghostTextIndex: this.ghost,
		};
	}

	private finish(state: PromptInputState): void {
		if (this.inputState === PromptInputState.Input) {
			this.finished.fire(this.snapshot());
		}
		this.inputState = state;
	}

	private sync(): void {
		if (
			this.inputState !== PromptInputState.Input ||
			!this.origin ||
			this.origin.isDisposed ||
			this.terminal.buffer.active.type !== 'normal'
		) {
			return;
		}
		const buffer = this.terminal.buffer.normal;
		const cursorLine = buffer.baseY + buffer.cursorY;
		if (cursorLine < this.origin.line) {
			return;
		}
		this.lastLine = Math.max(this.lastLine, cursorLine);
		let text = '';
		let cursor = -1;
		let ghost = -1;
		for (let y = this.origin.line; y <= Math.min(this.lastLine, buffer.length - 1); y++) {
			const row = buffer.getLine(y);
			if (!row) {
				continue;
			}
			let start = y === this.origin.line ? this.startX : 0;
			if (y > this.origin.line && !row.isWrapped) {
				text += '\n';
				if (this.continuation && row.translateToString(false).startsWith(this.continuation)) {
					// Prompt strings use UTF-16, while buffer coordinates count cells.
					let characters = 0;
					while (start < this.terminal.cols && characters < this.continuation.length) {
						characters += row.getCell(start)?.getChars().length ?? 0;
						start++;
					}
				}
			}
			const end =
				y === this.origin.line && this.rightPrompt && this.rightPrompt.end > this.rightPrompt.start
					? this.rightPrompt.start
					: this.terminal.cols;
			// xterm trims the full row before slicing, so a right prompt outside
			// this range can leave padding in the slice. Cursor cells below still
			// preserve spaces the user actually entered.
			const lineText = row.translateToString(true, start, end).replace(/ +$/, '');
			let line = '';
			for (
				let x = start;
				x < end && (line.length < lineText.length || (y === cursorLine && x < buffer.cursorX));
				x++
			) {
				if (y === cursorLine && x === buffer.cursorX) {
					cursor = text.length + line.length;
				}
				const cell = row.getCell(x);
				if (!cell || !cell.getWidth()) {
					continue;
				}
				const chars = cell.getChars() || ' ';
				const styledSuggestion =
					cell.isDim() ||
					((this.shell === PosixShellType.Fish || this.shell === GeneralShellType.PowerShell) &&
						cell.isItalic());
				if (ghost < 0 && y === cursorLine && x >= buffer.cursorX && chars.trim() && styledSuggestion) {
					ghost = text.length + line.length;
				}
				line += chars;
			}
			if (y === cursorLine && cursor < 0) {
				cursor = text.length + line.length;
			}
			text += line;
		}
		if (cursor < 0) {
			cursor = text.length;
		}
		if (text === this.text && cursor === this.cursor && ghost === this.ghost) {
			return;
		}
		this.text = text;
		this.cursor = cursor;
		this.ghost = ghost;
		this.log.trace('Prompt input changed', { length: text.length, cursor, ghost });
		this.changed.fire(this.snapshot());
	}
}
