import type { RoomStatus, RoomStatusParams } from '../../../../../.build/protocol/typescript/index.js';
import type { RoomOpenParams } from '../../../../../.build/protocol/typescript/index.js';
import type { RoomOpenResult } from '../../../../../.build/protocol/typescript/index.js';
import type { RoomPresenceParams } from '../../../../../.build/protocol/typescript/index.js';
import type { RoomPresenceReadParams } from '../../../../../.build/protocol/typescript/index.js';
import type { RoomPresenceSnapshot } from '../../../../../.build/protocol/typescript/index.js';
import type { RoomSubmitParams } from '../../../../../.build/protocol/typescript/index.js';
import type { RoomSubmitResult } from '../../../../../.build/protocol/typescript/index.js';

/** Typed transport boundary for server-ordered structured-document collaboration. */
export interface ICollabApi {
	readStatus(params: RoomStatusParams): Promise<RoomStatus>;
	open(params: RoomOpenParams): Promise<RoomOpenResult>;
	submit(params: RoomSubmitParams): Promise<RoomSubmitResult>;
	publishPresence(params: RoomPresenceParams): Promise<RoomPresenceSnapshot>;
	readPresence(params: RoomPresenceReadParams): Promise<RoomPresenceSnapshot>;
}
