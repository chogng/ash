import { Disposable } from "../../../../base/common/lifecycle.js";
import { CancellationError } from "../../../../base/common/errors.js";
import { throwIfCancelled } from "../../../../base/common/cancellation.js";
import type { DocumentCollaborationRoom } from '../common/documentCollaborationService.js';
import type { DocumentCollaborationOpenInput } from '../common/documentCollaborationService.js';
import type { IDocumentCollaborationService } from '../common/documentCollaborationService.js';
import { RemoteDocumentCollaborationService } from "./remoteDocumentCollaborationService.js";

/** Workbench-owned selection and routing for document collaboration transports. */
export class DocumentCollaborationService extends Disposable implements IDocumentCollaborationService {
	private readonly remote = this._register(new RemoteDocumentCollaborationService());

	constructor(private readonly ownerWindow: Window, private readonly appServer: IDocumentCollaborationService | undefined) {
		super();
		if (appServer) this._register(appServer);
	}

	async open(input: DocumentCollaborationOpenInput, signal: AbortSignal): Promise<DocumentCollaborationRoom> {
		throwIfCancelled(signal, "Opening a document collaboration room was cancelled");
		const endpoint = this.ownerWindow.prompt("Enter a remote collaboration server URL, or leave it blank to use this Workbench's App Server.", "");
		if (endpoint == null) throw new CancellationError("Choosing a document collaboration service was cancelled");
		if (!endpoint.trim()) {
			if (!this.appServer) throw new Error("This Workbench has no App Server collaboration service");
			return this.appServer.open(input, signal);
		}
		const bearerToken = this.ownerWindow.prompt("Enter the remote collaboration server bearer token.", "");
		if (bearerToken == null) throw new CancellationError("Choosing a document collaboration service was cancelled");
		throwIfCancelled(signal, "Opening a document collaboration room was cancelled");
		return this.remote.open(input, { endpoint: endpoint.trim(), bearerToken: bearerToken.trim() }, signal);
	}
}
