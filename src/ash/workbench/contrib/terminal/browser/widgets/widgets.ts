import type { IDisposable } from '../../../../../base/common/lifecycle.js';

/** One visible instance per ID. Its attachment lease owns its disposal. */
export interface ITerminalWidget extends IDisposable {
	readonly id: string;
	attach(container: HTMLElement): void;
}
