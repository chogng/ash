import type { Event } from '../../../../base/common/event.js';
import type { ITerminalProcessCommandStatusEvent } from '../terminal.js';

export const enum TerminalCapability {
	CwdDetection = 0,
	CommandDetection = 2,
}

/** Published metadata, positioned by its source after the corresponding byte commit. */
export type TerminalCommandSnapshot = Omit<ITerminalProcessCommandStatusEvent, 'sequence' | 'afterOutputSequence'>;

export interface ICwdDetectionCapability {
	getCwd(): string;
}

export interface ICommandDetectionCapability {
	readonly commands: readonly TerminalCommandSnapshot[];
	readonly hasRichCommandDetection: boolean;
	readonly commandStorageDisabled: boolean;
	readonly onCommandFinished: Event<TerminalCommandSnapshot>;
}

export interface ITerminalCapabilityImplMap {
	[TerminalCapability.CwdDetection]: ICwdDetectionCapability;
	[TerminalCapability.CommandDetection]: ICommandDetectionCapability;
}

export interface ITerminalCapabilityStore {
	readonly onDidAddCapability: Event<TerminalCapability>;
	readonly onDidRemoveCapability: Event<TerminalCapability>;
	has(id: TerminalCapability): boolean;
	get<T extends TerminalCapability>(id: T): ITerminalCapabilityImplMap[T] | undefined;
}
