import { type Event } from "../../../../base/common/event.js";
import { type URI } from "../../../../base/common/uri.js";

/** Request used by the editor to resolve a persisted or bootstrapped text resource. */
export interface TextResourceResolveRequest {
	readonly resource: URI;
	readonly bootstrapText?: string;
}

/** Text returned by a resource adapter. */
export interface TextResourceContent {
	readonly resource: URI;
	readonly text: string;
	/** Opaque file revision when the resource was resolved from persistent storage. */
	readonly revision: string | undefined;
}

/** Resource-content write requested by a text model service. */
export interface TextResourceSaveRequest {
	readonly resource: URI;
	readonly text: string;
	readonly expectedRevision?: string;
}

/** Result returned after persistent text has been accepted. */
export interface TextResourceSaveResult {
	readonly revision: string | undefined;
}

/** The resource changed after the model resolved it, so persistence was rejected. */
export class TextResourceConflictError extends Error {
	constructor(readonly resource: URI) {
		super(`Text resource changed since it was resolved: ${resource.toString()}`);
		this.name = "TextResourceConflictError";
	}
}

/** Coarse invalidation event for resources that may have changed externally. */
export interface TextResourceChangeEvent {
	readonly resources: readonly URI[] | undefined;
}

/**
 * Persistence boundary for editor text.
 *
 * Implementations adapt a concrete file/runtime service to this contract;
 * model and editor common code must not depend on that runtime service.
 */
export interface ITextResourceStore {
	readonly onDidChange: Event<TextResourceChangeEvent>;
	resolve(request: TextResourceResolveRequest, signal: AbortSignal): Promise<TextResourceContent>;
	save(request: TextResourceSaveRequest, signal: AbortSignal): Promise<TextResourceSaveResult>;
}
