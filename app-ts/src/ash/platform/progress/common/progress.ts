import { type Event } from "../../../base/common/event.js";
import { type IDisposable } from "../../../base/common/lifecycle.js";
import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

/** One incremental update to a progress task. */
export interface ProgressUpdate {
	readonly message?: string;
	readonly increment?: number;
	readonly total?: number;
}

/** Configuration for one progress task. */
export interface ProgressOptions {
	readonly title: string;
	readonly total?: number;
	readonly cancellable?: boolean;
}

/** Immutable progress state published to observers. */
export interface ProgressSnapshot {
	readonly id: number;
	readonly title: string;
	readonly message?: string;
	readonly worked: number;
	readonly total?: number;
	readonly cancellable: boolean;
	readonly cancelled: boolean;
	readonly done: boolean;
}

export type ProgressChange =
	| { readonly kind: "started"; readonly progress: ProgressSnapshot }
	| { readonly kind: "updated"; readonly progress: ProgressSnapshot }
	| { readonly kind: "done"; readonly progress: ProgressSnapshot };

/** Handle for one running progress task. */
export interface ProgressHandle extends IDisposable {
	readonly id: number;
	readonly signal: AbortSignal;
	report(update: ProgressUpdate): void;
	done(): void;
	cancel(): void;
}

/** Window-scoped progress service. */
export interface IProgressService {
	readonly onDidChange: Event<ProgressChange>;

	startProgress(options: ProgressOptions): ProgressHandle;
	withProgress<T>(
		options: ProgressOptions,
		task: (progress: Pick<ProgressHandle, "report">, signal: AbortSignal) => Promise<T> | T,
	): Promise<T>;
}

export const IProgressService = createServiceIdentifier<IProgressService>("progressService");
