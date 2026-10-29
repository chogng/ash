/** A complete Server-Sent Event, independent of transport chunk boundaries. */
export interface ISSEEvent {
	type: string;
	data: string;
	id?: string;
	retry?: number;
}

export type SSEEventHandler = (event: ISSEEvent) => void;

/** Decodes UTF-8 and dispatches events only after their terminating blank line. */
export class SSEParser {
	private readonly decoder = new TextDecoder();
	private line = '';
	private skipLineFeed = false;
	private readonly data: string[] = [];
	private type = '';
	private id: string | undefined;
	private retry: number | undefined;

	constructor(private readonly onEvent: SSEEventHandler) { }

	public feed(chunk: Uint8Array): void {
		const text = this.decoder.decode(chunk, { stream: true });
		let start = 0;
		for (let index = 0; index < text.length; index++) {
			const character = text[index];
			if (this.skipLineFeed && character === '\n') {
				this.skipLineFeed = false;
				start = index + 1;
				continue;
			}
			this.skipLineFeed = false;
			if (character !== '\r' && character !== '\n') continue;
			const line = this.line + text.slice(start, index);
			this.line = '';
			this.skipLineFeed = character === '\r';
			start = index + 1;
			this.acceptLine(line);
		}
		this.line += text.slice(start);
	}

	private acceptLine(line: string): void {
		if (line.length === 0) {
			const event: ISSEEvent | undefined = this.data.length ? {
				type: this.type || 'message',
				data: this.data.join('\n'),
				...(this.id === undefined ? {} : { id: this.id }),
				...(this.retry === undefined ? {} : { retry: this.retry }),
			} : undefined;
			this.type = '';
			this.data.length = 0;
			if (event) this.onEvent(event);
			return;
		}
		const colon = line.indexOf(':');
		const field = colon < 0 ? line : line.slice(0, colon);
		let value = colon < 0 ? '' : line.slice(colon + 1);
		if (value.startsWith(' ')) value = value.slice(1);
		switch (field) {
			case 'data': this.data.push(value); break;
			case 'event': this.type = value; break;
			case 'id': if (!value.includes('\0')) this.id = value; break;
			case 'retry':
				if (/^\d+$/.test(value) && Number.isSafeInteger(Number(value))) this.retry = Number(value);
				break;
		}
	}
}
