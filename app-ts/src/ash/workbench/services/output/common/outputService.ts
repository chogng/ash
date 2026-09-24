import type { Event } from "../../../../base/common/event.js";
import type { IDisposable } from "../../../../base/common/lifecycle.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";

export type OutputEntrySeverity = "trace" | "debug" | "information" | "warning" | "error" | "log";
export type OutputChannelKind = "output" | "log";
export type OutputChannelSource = "core" | "extension" | "user";
export type OutputChannelChangeKind = "append" | "replace" | "clear";
export type OutputChannelRevealFocus = "take" | "preserve";

/** One immutable chunk retained by an Output channel. */
export interface IOutputEntry {
	readonly sequence: number;
	readonly timestamp: number;
	readonly severity: OutputEntrySeverity;
	readonly category?: string;
	readonly text: string;
}

/** Caller-owned content supplied when updating an Output channel. */
export interface IOutputEntryInput {
	readonly severity?: OutputEntrySeverity;
	readonly timestamp?: number;
	readonly category?: string;
	readonly text: string;
}

/** Stable identity and presentation metadata for one Output producer. */
export interface IOutputChannelDescriptor {
	readonly id: string;
	readonly label: string;
	readonly kind?: OutputChannelKind;
	readonly source?: OutputChannelSource;
	readonly extensionId?: string;
	readonly languageId?: string;
}

/** One atomic content-model transition. */
export interface IOutputChannelChange {
	readonly kind: OutputChannelChangeKind;
	readonly appended: readonly IOutputEntry[];
}

export interface IOutputChannelRevealOptions {
	readonly focus: OutputChannelRevealFocus;
}

export interface IOutputChannelRevealRequest {
	readonly channel: IOutputChannel;
	readonly focus: OutputChannelRevealFocus;
}

/**
 * Caller-owned registration for one independently clearable Output stream.
 * Implementations retain bounded content and producers dispose the channel
 * when their capability is no longer available.
 */
export interface IOutputChannel extends IDisposable {
	readonly descriptor: IOutputChannelDescriptor;
	readonly id: string;
	readonly label: string;
	readonly kind: OutputChannelKind;
	readonly entries: readonly IOutputEntry[];
	readonly onDidChange: Event<IOutputChannelChange>;
	append(entry: IOutputEntryInput): void;
	appendLine(entry: IOutputEntryInput): void;
	replace(entries: IOutputEntryInput | readonly IOutputEntryInput[]): void;
	clear(): void;
	getText(): string;
	show(options?: IOutputChannelRevealOptions): void;
}

/** Window-scoped registry, active selection, and reveal intent for Output. */
export interface IOutputService {
	readonly channels: readonly IOutputChannel[];
	readonly activeChannel: IOutputChannel | undefined;
	readonly onDidChangeChannels: Event<void>;
	readonly onDidChangeActiveChannel: Event<IOutputChannel | undefined>;
	readonly onDidRequestShowChannel: Event<IOutputChannelRevealRequest>;
	createChannel(descriptor: IOutputChannelDescriptor): IOutputChannel;
	getChannel(id: string): IOutputChannel | undefined;
	selectChannel(id: string): void;
	showChannel(id: string, options?: IOutputChannelRevealOptions): void;
}

export const IOutputService = createServiceIdentifier<IOutputService>("outputService");
