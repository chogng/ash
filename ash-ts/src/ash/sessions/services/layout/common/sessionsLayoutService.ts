import type { ISize } from "../../../../base/common/layout.js";
import type { Event } from "../../../../base/common/event.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";

export const sessionsPartIds = ["titlebar", "sidebar", "sessions", "auxiliarybar"] as const;

export type SessionsPartId = typeof sessionsPartIds[number];

/** Describes a dedicated Sessions Part whose effective visibility changed. */
export interface SessionsPartVisibilityChangeEvent {
	readonly partId: SessionsPartId;
	readonly visible: boolean;
}

/** Window-scoped Part operations implemented by the dedicated Sessions layout. */
export interface ISessionsLayoutService {
	readonly onDidChangePartVisibility: Event<SessionsPartVisibilityChangeEvent>;
	isPartVisible(partId: SessionsPartId): boolean;
	showPart(partId: SessionsPartId): void;
	hidePart(partId: SessionsPartId): void;
	getPartSize(partId: SessionsPartId): ISize;
	resizePart(partId: SessionsPartId, dimension: ISize): void;
}

export const ISessionsLayoutService = createServiceIdentifier<ISessionsLayoutService>("sessionsLayoutService");
