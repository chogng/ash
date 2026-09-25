import { Disposable } from "../../../../base/common/lifecycle.js";
import { CancellationError } from "../../../../base/common/errors.js";
import { throwIfCancelled } from "../../../../base/common/cancellation.js";
import { assertDefined } from "../../../../base/common/types.js";
import { localize } from "../../../../nls.js";
import { IDialogService } from "../../../../platform/dialogs/common/dialogs.js";
import type { DocumentCollaborationRoom } from '../common/documentCollaborationService.js';
import type { DocumentCollaborationOpenInput } from '../common/documentCollaborationService.js';
import type { IDocumentCollaborationService } from '../common/documentCollaborationService.js';
import { RemoteDocumentCollaborationService } from "./remoteDocumentCollaborationService.js";

/** Workbench-owned selection and routing for document collaboration transports. */
export class DocumentCollaborationService extends Disposable implements IDocumentCollaborationService {
	private readonly remote = this._register(new RemoteDocumentCollaborationService());

	constructor(private readonly appServer: IDocumentCollaborationService | undefined, @IDialogService private readonly dialogs: IDialogService) {
		super();
		if (appServer) this._register(appServer);
	}

	async open(input: DocumentCollaborationOpenInput, signal: AbortSignal): Promise<DocumentCollaborationRoom> {
		throwIfCancelled(signal, "Opening a document collaboration room was cancelled");
		const endpointDialog = await this.dialogs.input({
			title: localize('collaboration.dialog.endpointTitle', 'Collaboration server'),
			message: localize('collaboration.dialog.endpointMessage', "Enter a remote collaboration server URL, or leave it blank to use this Workbench's App Server."),
			inputs: [{ value: '' }],
		});
		if (!endpointDialog.confirmed) throw new CancellationError("Choosing a document collaboration service was cancelled");
		const endpoint = endpointDialog.values?.[0];
		assertDefined(endpoint, new Error('The collaboration endpoint dialog returned no value'));
		if (!endpoint.trim()) {
			if (!this.appServer) throw new Error("This Workbench has no App Server collaboration service");
			return this.appServer.open(input, signal);
		}
		const tokenDialog = await this.dialogs.input({
			title: localize('collaboration.dialog.tokenTitle', 'Collaboration token'),
			message: localize('collaboration.dialog.tokenMessage', 'Enter the remote collaboration server bearer token.'),
			inputs: [{ type: 'password', value: '' }],
		});
		if (!tokenDialog.confirmed) throw new CancellationError("Choosing a document collaboration service was cancelled");
		const bearerToken = tokenDialog.values?.[0];
		assertDefined(bearerToken, new Error('The collaboration token dialog returned no value'));
		throwIfCancelled(signal, "Opening a document collaboration room was cancelled");
		return this.remote.open(input, { endpoint: endpoint.trim(), bearerToken: bearerToken.trim() }, signal);
	}
}
