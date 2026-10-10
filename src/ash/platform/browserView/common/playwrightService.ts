import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { BrowserViewAction, IBrowserViewObservation, IBrowserViewObservationOptions } from './browserView.js';

export const IPlaywrightService = createServiceIdentifier<IPlaywrightService>('playwrightService');
/** Desktop automation lives in the shared process; every call is scoped to a real Thread. */
export interface IPlaywrightService {
	/** The Workbench adapter forwards network authority to Main; the worker runs within Main's lease. */
	getObservation(operationId: string, sessionId: string, pageId: string, options: IBrowserViewObservationOptions, networkToken?: string | null): Promise<IBrowserViewObservation>;
	performAction(operationId: string, sessionId: string, pageId: string, action: BrowserViewAction, networkToken?: string | null): Promise<void>;
	/** Main cancels the request promptly and retains the worker's completion barrier before releasing page order. */
	cancelOperation(operationId: string): Promise<void>;
	/** Cancels pending automation and releases its connection without closing the user's pages. */
	disposeSession(sessionId: string): Promise<void>;
}
