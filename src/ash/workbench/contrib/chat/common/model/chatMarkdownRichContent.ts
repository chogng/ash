import type { Icon } from '../../../../../base/common/icon.js';
import { createUuid } from '../../../../../base/common/uuid.js';

export const EDIT_CHAT_WRITING_COMMAND_ID = 'chat.response.editWriting';

export type ChatMarkdownRichStyle = Readonly<Partial<Record<
	'radius' | 'padding' | 'gap' | 'align' | 'justify' | 'background' | 'color' | 'size' | 'border' | 'borderColor',
	string
>> & { appearance?: 'badge'; flex?: '1'; }>;

interface ChatMarkdownRichBody {
	readonly markdown: string;
	readonly block: boolean;
}

interface ChatMarkdownRichLink {
	readonly label: string;
	readonly href: string;
}

export interface ChatMarkdownEntity {
	readonly label: string;
	readonly category: string;
	readonly disambiguation: string;
}

export type ChatMarkdownRichPart =
	| ({ readonly kind: 'markdown'; } & ChatMarkdownRichBody)
	| ({ readonly kind: 'writing'; readonly title?: string; } & ChatMarkdownRichBody)
	| ({ readonly kind: 'box' | 'row' | 'text'; readonly style: ChatMarkdownRichStyle; readonly fallback?: ChatMarkdownRichLink; } & ChatMarkdownRichBody)
	| ({ readonly kind: 'grid'; readonly columns: 1 | 2 | 3 | 4; readonly style: ChatMarkdownRichStyle; } & ChatMarkdownRichBody)
	| ({ readonly kind: 'gridItem'; } & ChatMarkdownRichBody)
	| { readonly kind: 'icon'; readonly icon?: Icon; readonly label: string; readonly style: ChatMarkdownRichStyle; readonly block: boolean; readonly fallback: ChatMarkdownRichLink; }
	| ({ readonly kind: 'details'; readonly label: string; readonly data: string; } & ChatMarkdownRichBody)
	| { readonly kind: 'citations'; readonly entries: readonly { readonly number: number; readonly title: string; readonly url: string; readonly snippet: string; }[]; readonly block: boolean; }
	| { readonly kind: 'textLiteral'; readonly label: string; readonly block: boolean; }
	| { readonly kind: 'entity'; readonly entity: ChatMarkdownEntity; readonly block: boolean; }
	| { readonly kind: 'image'; readonly uri: string; readonly label: string; readonly block: boolean; }
	| { readonly kind: 'imageGallery'; readonly images: readonly { readonly uri: string; readonly label: string; readonly source?: string; }[]; readonly block: boolean; readonly compact?: boolean; }
	| { readonly kind: 'link'; readonly link: ChatMarkdownRichLink; readonly title?: string; readonly external?: true; readonly block: boolean; }
	| ({ readonly kind: 'resource'; readonly label: string; readonly uri?: string; readonly title?: string; readonly data?: string; } & ChatMarkdownRichBody)
	| { readonly kind: 'unavailableMedia'; readonly fallback: ChatMarkdownRichLink; readonly block: boolean; };

export interface ChatMarkdownRichContent {
	readonly markerPrefix: string;
	readonly parts: readonly ChatMarkdownRichPart[];
}

/** Inserts references to typed parts without changing the surrounding Markdown grammar. */
export class ChatMarkdownRichContentBuilder {
	private readonly parts: ChatMarkdownRichPart[] = [];
	private readonly markerPrefix: string;

	constructor(source: string) {
		const prefix = '<:ash-rich:';
		// Keep references stable across streamed snapshots unless the input already uses this prefix.
		this.markerPrefix = source.includes(prefix) ? '<:ash-rich-' + createUuid() + ':' : prefix;
	}

	public add(part: ChatMarkdownRichPart): string {
		const marker = this.markerPrefix + this.parts.length + ':>';
		this.parts.push(part);
		return marker;
	}

	public get content(): ChatMarkdownRichContent | undefined {
		return this.parts.length ? { markerPrefix: this.markerPrefix, parts: this.parts } : undefined;
	}
}
