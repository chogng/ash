import type { SessionMode } from '../../../../platform/agentHost/common/agent.js';
import type { IOpenAgentsWindowOptions } from '../../../../platform/native/common/nativeHost.js';
import type { URI } from '../../../../base/common/uri.js';
import type { VSBuffer } from '../../../../base/common/buffer.js';
import type { ITerminalOutputSnapshot } from '../../../../platform/terminal/common/terminal.js';

export interface ResolvedChatContext {
	readonly name: string;
	readonly content: string;
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
	/** Original source; the resolved content remains the selected snapshot. */
	readonly resource?: URI;
	readonly name: string;
	/** Position of the visible reference in the message; older saved drafts may omit it. */
	readonly reference?: { readonly start: number; readonly end: number; };
	resolve(): Promise<ResolvedChatContext>;
}

/** Carry composer positions alongside the captured content without changing the shared snapshot. */
export async function resolveChatContextAttachment(attachment: ChatContextAttachment): Promise<ResolvedChatContext> {
	const snapshot = await attachment.resolve();
	return attachment.reference ? { ...snapshot, reference: attachment.reference } : snapshot;
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

/** Serializes the accepted composer snapshot for a workspace or window handoff. */
export async function captureChatDraft(text: string, mode: SessionMode, attachments: readonly ChatContextAttachment[]): Promise<NonNullable<IOpenAgentsWindowOptions['draft']>> {
	const contexts = await Promise.all(attachments.map(async attachment => ({
		id: attachment.id,
		kind: attachment.kind,
		name: attachment.name,
		content: (await attachment.resolve()).content,
		...(attachment.resource ? { resource: attachment.resource.toString() } : {}),
		...(attachment.terminalSnapshot ? { terminalSnapshot: attachment.terminalSnapshot } : {}),
		...(attachment.reference ? { reference: attachment.reference } : {}),
	})));
	return { mode, text, contexts };
}
