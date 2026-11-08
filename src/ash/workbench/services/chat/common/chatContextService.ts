import type { SessionMode } from '../../../../platform/agentHost/common/agent.js';
import type { IOpenAgentsWindowOptions } from '../../../../platform/native/common/nativeHost.js';
import type { URI } from '../../../../base/common/uri.js';
import type { VSBuffer } from '../../../../base/common/buffer.js';
import type { ITerminalOutputSnapshot } from '../../../../platform/terminal/common/terminal.js';
import type { ThemeIcon } from '../../../../base/common/themables.js';
import type { IMarkdownString } from '../../../../base/common/htmlContent.js';

export interface ResolvedChatContext {
	readonly sourceUrl?: string;
	readonly name: string;
	readonly content: string;
	/** The backend reads this conversation when it admits the Turn, including queued Turns. */
	readonly chatReference?: { readonly sessionId: string; readonly threadId: string; };
	/** UTF-16 offsets in the untrimmed submitted text, replacing the visible attachment label. */
	readonly reference?: { readonly start: number; readonly end: number; };
	/** Images hold a URL; instructions hold an authorized backend path; tool selections hold a JSON array of disabled names. */
	readonly kind?: 'image' | 'instruction' | 'toolSelection';
}

export interface ChatContextAttachment {
	/** Source-owned context stays until its producer closes or the user removes it. */
	readonly lifetime?: 'submission' | 'source';
	readonly terminalSnapshot?: ITerminalOutputSnapshot;
	readonly id: string;
	readonly kind: string;
	/** Original source for opening an attachment. */
	readonly resource?: URI;
	readonly name: string;
	/** Provider presentation is optional; accepted content remains an immutable draft snapshot. */
	readonly iconPath?: ThemeIcon | URI | { light: URI; dark: URI; };
	readonly tooltip?: IMarkdownString;
	/** A source-owned action can retire independently of the saved attachment content. */
	readonly open?: () => Promise<void>;
	/** Position of the visible reference in the message; older saved drafts may omit it. */
	readonly reference?: { readonly start: number; readonly end: number; };
	resolve(): Promise<ResolvedChatContext>;
}

/** Carry composer positions alongside the captured content without changing the shared snapshot. */
export async function resolveChatContextAttachment(attachment: ChatContextAttachment): Promise<ResolvedChatContext> {
	const snapshot = await attachment.resolve();
	const sourceUrl = attachment.kind === 'transcriptContext' && attachment.resource?.scheme === 'https' ? attachment.resource.toString() : undefined;
	return { ...snapshot, ...(sourceUrl ? { sourceUrl } : {}), ...(attachment.reference ? { reference: attachment.reference } : {}) };
}

/** A host-owned producer borrows the destination draft's cancellation signal. */
export type ChatImageCapture = (signal: AbortSignal) => Promise<VSBuffer | undefined>;

/** A Chat view that accepts context from another Workbench contribution. */
export interface IChatContextTarget {
	addContext(attachment: ChatContextAttachment): void;
	/** Appends to the currently visible composer synchronously, preserving its draft and attachments. */
	appendToDraft(text: string): void;
	/** Captures and previews an image through the active composer’s attachment lifecycle. */
	captureScreenshot(capture?: ChatImageCapture): Promise<void>;
	acceptInput(value?: string): Promise<void>;
}

/** Serializes attachments for drafts, clipboard and window handoff. */
export async function captureChatDraft(text: string, mode: SessionMode, attachments: readonly ChatContextAttachment[]): Promise<NonNullable<IOpenAgentsWindowOptions['draft']>> {
	const contexts = await Promise.all(attachments.map(async attachment => {
		const resolved = await attachment.resolve();
		return {
			id: attachment.id,
			kind: attachment.kind,
			name: attachment.name,
			content: resolved.content,
			...(resolved.chatReference ? { chatReference: true as const } : {}),
			...(attachment.resource ? { resource: attachment.resource.toString() } : {}),
			...(attachment.terminalSnapshot ? { terminalSnapshot: attachment.terminalSnapshot } : {}),
			...(attachment.reference ? { reference: attachment.reference } : {}),
		};
	}));
	return { mode, text, contexts };
}
