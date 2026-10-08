import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import type { URI } from '../../../../base/common/uri.js';
import type { ITextModel } from '../../../../editor/common/model.js';
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
	readonly uri: URI;
	readonly descriptor: IOutputChannelDescriptor;
	readonly id: string;
	readonly label: string;
	readonly kind: OutputChannelKind;
	readonly entries: readonly IOutputEntry[];
	readonly onDidChange: Event<IOutputChannelChange>;
	loadModel(): Promise<ITextModel>;
	append(entry: IOutputEntryInput): void;
	appendLine(entry: IOutputEntryInput): void;
	replace(entries: IOutputEntryInput | readonly IOutputEntryInput[]): void;
	clear(): void;
	getText(): string;
	show(options?: IOutputChannelRevealOptions): void;
}

/** Window-scoped registry, active selection, and reveal intent for Output. */
export interface IOutputService {
	readonly filters: IOutputViewFilters;
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

export const OUTPUT_VIEW_ID = "ash.output";
export const SHOW_OUTPUT_COMMAND_ID = "workbench.action.output.show";
export const SHOW_OUTPUT_CHANNELS_COMMAND_ID = "workbench.action.output.showChannels";
export const CLEAR_OUTPUT_COMMAND_ID = "workbench.action.output.clear";
export const OPEN_OUTPUT_IN_EDITOR_COMMAND_ID = "workbench.action.output.openInEditor";
export const EXPORT_OUTPUT_COMMAND_ID = "workbench.action.output.export";

export const OUTPUT_MODE_ID = 'Log';
export const LOG_MODE_ID = 'log';
export const OutputSeverities: readonly OutputEntrySeverity[] = Object.freeze(['trace', 'debug', 'information', 'warning', 'error', 'log']);

/** Structured producer metadata drives view filtering without changing shared text. */
export interface IOutputViewFilters {
	readonly text: string;
	/** Input guidance derived from saved-query compatibility, never a selectable mode. */
	readonly textFilterNotice: 'restored' | 'unsupported' | undefined;
	readonly onDidChange: Event<void>;
	setText(text: string): void;
	isSeverityVisible(severity: OutputEntrySeverity): boolean;
	setSeverityVisible(severity: OutputEntrySeverity, visible: boolean): void;
	setMinimumSeverity(severity: OutputEntrySeverity): void;
	isCategoryVisible(category: string, channelId: string): boolean;
	/** Explicit category input moves any legacy global choice to this channel only. */
	setCategoryVisible(category: string, visible: boolean, channelId: string): void;
	reset(): void;
	matches(entry: IOutputEntry, channelId: string): boolean;
}

export const CONTEXT_IN_OUTPUT = new RawContextKey<boolean>('inOutput', false);
