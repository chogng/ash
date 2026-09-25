import "./media/collaborationContribution.css";
import { ToolBar } from "../../../../base/browser/ui/toolbar/toolbar.js";
import type { IContextMenuProvider } from "../../../../base/browser/contextmenu.js";
import type { IAction } from "../../../../base/common/actions.js";
import { isCancellationError } from "../../../../base/common/errors.js";
import { Lxicon } from "../../../../base/common/lxicons.js";
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import type { DocumentCollaborationInvite } from "../../../services/documentCollaboration/common/documentCollaborationService.js";
import type { DocumentCollaborationMember } from "../../../services/documentCollaboration/common/documentCollaborationService.js";
import type { DocumentCollaborationRoomRole } from "../../../services/documentCollaboration/common/documentCollaborationService.js";
import { addDisposableListener, h, fragment as createFragment } from "../../../../base/browser/dom.js";

export type CollaborationToolbarState = "unavailable" | "inactive" | "connecting" | "connected" | "resyncRequired" | "error";

export interface CollaborationStartResult {
	readonly roomId: string;
	readonly principalId: string | undefined;
	readonly canManageMembers: boolean;
}

export interface CollaborationContributionOptions {
	readonly onStart: (roomId: string | undefined) => Promise<CollaborationStartResult>;
	readonly onStop: () => void;
	readonly onInvite: (displayName: string, role: DocumentCollaborationRoomRole) => Promise<DocumentCollaborationInvite>;
	readonly onListMembers: () => Promise<readonly DocumentCollaborationMember[]>;
	readonly onRotateMemberAccessToken: (principalId: string) => Promise<DocumentCollaborationInvite>;
	readonly onRevokeMember: (principalId: string) => Promise<void>;
}

/** Browser contribution that exposes document collaboration without owning state or transport. */
export class CollaborationContribution extends Disposable {
	readonly element: HTMLDivElement;
	private readonly toolbar: ToolBar;
	private readonly status: HTMLSpanElement;
	private readonly invitation: HTMLDivElement;
	private readonly invitationToken: HTMLPreElement;
	private readonly members: HTMLDivElement;
	private readonly memberList: HTMLDivElement;
	private _state: CollaborationToolbarState = "unavailable";
	private roomId: string | undefined;
	private message: string | undefined;
	private principalId: string | undefined;
	private canManageMembers = false;
	private startGeneration = 0;
	private readonly memberActionListeners = this._register(new MutableDisposable<DisposableStore>());

	constructor(container: HTMLElement, private readonly options: CollaborationContributionOptions) {
		super();
		const ownerDocument = container.ownerDocument;
		const element = h(ownerDocument, "div");
		element.className = "stanza-document-collaboration-toolbar";
		element.hidden = true;
		element.setAttribute("role", "group");
		element.setAttribute("aria-label", "Document collaboration");
		this.element = element;
		container.append(element);
		this._register(toDisposable(() => element.remove()));
		this.toolbar = this._register(new ToolBar(element, {
			contextMenuProvider: emptyCollaborationContextMenuProvider,
			ariaLabel: "Document collaboration",
			highlightToggledItems: true,
		}));
		this.toolbar.element.classList.add("stanza-document-collaboration-actions");
		this._register(addDisposableListener(this.toolbar.element, 'mousedown', event => event.preventDefault()));
		const status = h(ownerDocument, "span");
		status.className = "stanza-document-collaboration-status";
		status.setAttribute("role", "status");
		this.status = status;
		const invitation = h(ownerDocument, "div");
		invitation.className = "stanza-document-collaboration-invitation";
		invitation.hidden = true;
		invitation.setAttribute("role", "group");
		invitation.setAttribute("aria-label", "Collaboration invitation");
		this.invitation = invitation;
		const invitationToken = h(ownerDocument, "pre");
		invitationToken.className = "stanza-document-collaboration-invitation-token";
		invitationToken.tabIndex = 0;
		invitationToken.setAttribute("aria-label", "Invitation credentials");
		this.invitationToken = invitationToken;
		const dismissInvitation = h(ownerDocument, "button");
		dismissInvitation.className = "stanza-document-collaboration-invitation-dismiss";
		dismissInvitation.type = "button";
		dismissInvitation.textContent = "Dismiss";
		this._register(addDisposableListener(dismissInvitation, 'click', () => this.clearInvitation()));
		invitation.append(invitationToken, dismissInvitation);
		const members = h(ownerDocument, "div");
		members.className = "stanza-document-collaboration-members";
		members.hidden = true;
		members.setAttribute("role", "group");
		members.setAttribute("aria-label", "Collaboration members");
		this.members = members;
		const memberList = h(ownerDocument, "div");
		memberList.className = "stanza-document-collaboration-member-list";
		memberList.setAttribute("role", "list");
		this.memberList = memberList;
		members.append(memberList);
		element.append(this.toolbar.element, status, invitation, members);
		this.render();
	}

	setState(state: CollaborationToolbarState, options: { readonly roomId?: string; readonly message?: string; readonly principalId?: string; readonly canManageMembers?: boolean } = {}): void {
		this.startGeneration += 1;
		this._state = state;
		this.roomId = options.roomId;
		this.message = options.message;
		if (state !== "connected") {
			this.clearInvitation();
			this.clearMembers();
			this.principalId = undefined;
		}
		if (options.principalId !== undefined) this.principalId = options.principalId;
		if (options.canManageMembers !== undefined) this.canManageMembers = options.canManageMembers;
		else if (state !== "connected") this.canManageMembers = false;
		this.render();
	}

	private render(): void {
		const connected = this._state === "connected";
		const busy = this._state === "connecting";
		const enabled = this._state !== "unavailable" && !busy;
		this.element.dataset.state = this._state;
		const actions = [createAction(
			connected ? "stopCollaboration" : "startCollaboration",
			connected ? "Stop collaborating" : "Collaborate",
			connected ? "Leave this collaboration room" : "Create or join a collaboration room",
			enabled,
			connected,
			() => this.toggle(),
		)];
		if (connected && this.canManageMembers) {
			actions.push(createAction("inviteCollaborator", "Invite collaborator", "Create a room invitation", true, false, () => this.createInvite()));
			actions.push(createAction("manageCollaborators", "Manage collaborators", "View, rotate, or revoke active room members", true, false, () => this.manageCollaborators()));
		}
		this.toolbar.setActions(actions);
		this.status.textContent = this.statusText();
	}

	private statusText(): string {
		switch (this._state) {
			case "unavailable": return "Collaboration unavailable";
			case "inactive": return "Share a room ID to collaborate";
			case "connecting": return "Connecting…";
			case "connected": {
				const connected = this.roomId ? `Room: ${this.roomId}` : "Connected";
				return this.message ? `${connected} — ${this.message}` : connected;
			}
			case "resyncRequired": return this.roomId ? `Room ${this.roomId}: ${this.message ?? "rejoin required"}` : this.message ?? "Collaboration requires a resync";
			case "error": return this.roomId ? `Room ${this.roomId}: ${this.message ?? "collaboration failed"}` : this.message ?? "Collaboration failed";
		}
	}

	private isCurrentRoom(roomId: string, principalId: string | undefined): boolean {
		return !this.isDisposed && this._state === "connected" && this.roomId === roomId && this.principalId === principalId;
	}

	private toggle(): void {
		if (this._state === "connected") {
			this.options.onStop();
			return;
		}
		const entered = this.element.ownerDocument.defaultView?.prompt("Enter a collaboration room ID to join, or leave it blank to create one.", "");
		if (entered == null) return;
		this.setState("connecting");
		const generation = this.startGeneration;
		void this.options.onStart(entered.trim() || undefined).then(
			result => {
				if (this.isDisposed || generation !== this.startGeneration || this._state !== "connecting") {
					return;
				}
				this.setState("connected", { roomId: result.roomId, principalId: result.principalId, canManageMembers: result.canManageMembers });
			},
			error => {
				if (this.isDisposed || generation !== this.startGeneration || this._state !== "connecting") {
					return;
				}
				if (isCancellationError(error)) this.setState("inactive");
				else this.setState("error", { message: error instanceof Error ? error.message : "Collaboration could not be started" });
			},
		);
	}

	private createInvite(): void {
		if (this._state !== "connected" || !this.roomId || !this.canManageMembers) return;
		const displayName = this.element.ownerDocument.defaultView?.prompt("Enter a collaborator name.", "");
		if (displayName == null) return;
		const role = this.requestInviteRole();
		if (!role) return;
		const roomId = this.roomId;
		const principalId = this.principalId;
		void this.options.onInvite(displayName, role).then(
			invite => {
				if (!this.isCurrentRoom(roomId, principalId)) {
					return;
				}
				this.setState("connected", { roomId, principalId, canManageMembers: true, message: `Invitation created for ${invite.displayName}` });
				this.showInvitation(invite);
			},
			error => {
				if (!this.isCurrentRoom(roomId, principalId)) {
					return;
				}
				this.setState("connected", {
					roomId,
					principalId,
					canManageMembers: true,
					message: error instanceof Error ? error.message : "Collaboration invitation could not be created",
				});
			},
		);
	}

	private manageCollaborators(): void {
		if (this._state !== "connected" || !this.roomId || !this.canManageMembers) return;
		this.refreshMembers();
	}

	private refreshMembers(): void {
		if (this._state !== "connected" || !this.roomId || !this.canManageMembers) return;
		const roomId = this.roomId;
		const principalId = this.principalId;
		this.members.hidden = false;
		this.memberActionListeners.clear();
		this.memberList.replaceChildren("Loading collaborators…");
		void this.options.onListMembers().then(
			members => {
				if (!this.isCurrentRoom(roomId, principalId)) {
					return;
				}
				this.renderMembers(members);
			},
			error => {
				if (!this.isCurrentRoom(roomId, principalId)) {
					return;
				}
				this.setState("connected", {
					roomId,
					principalId,
					canManageMembers: true,
					message: error instanceof Error ? error.message : "Collaboration members could not be read",
				});
			},
		);
	}

	private renderMembers(members: readonly DocumentCollaborationMember[]): void {
		const document = this.element.ownerDocument;
		const fragment = createFragment(document);
		const listeners = new DisposableStore();
		this.memberActionListeners.value = listeners;
		if (members.length === 0) {
			const empty = h(document, "div");
			empty.className = "stanza-document-collaboration-members-empty";
			empty.setAttribute("role", "listitem");
			empty.textContent = "No active collaborators";
			fragment.append(empty);
		}
		for (const member of members) {
			const item = h(document, "div");
			item.className = "stanza-document-collaboration-member";
			item.setAttribute("role", "listitem");
			item.dataset.principalId = member.principalId;
			const identity = h(document, "span");
			identity.className = "stanza-document-collaboration-member-identity";
			identity.textContent = member.displayName;
			const details = h(document, "span");
			details.className = "stanza-document-collaboration-member-details";
			details.textContent = `${member.role} · ${member.principalId}`;
			const actions = h(document, "span");
			actions.className = "stanza-document-collaboration-member-actions";
			const rotate = h(document, "button");
			rotate.type = "button";
			rotate.textContent = "Rotate token";
			listeners.add(addDisposableListener(rotate, 'click', () => this.rotateMemberAccessToken(member)));
			actions.append(rotate);
			const revoke = h(document, "button");
			revoke.type = "button";
			revoke.textContent = "Revoke";
			if (member.principalId === this.principalId) {
				revoke.disabled = true;
				revoke.title = "You cannot revoke your own active owner credential";
			}
			listeners.add(addDisposableListener(revoke, 'click', () => this.revokeMember(member)));
			actions.append(revoke);
			item.append(identity, details, actions);
			fragment.append(item);
		}
		this.memberList.replaceChildren(fragment);
	}

	private rotateMemberAccessToken(member: DocumentCollaborationMember): void {
		if (this._state !== "connected" || !this.roomId || !this.canManageMembers) return;
		const roomId = this.roomId;
		const principalId = this.principalId;
		void this.options.onRotateMemberAccessToken(member.principalId).then(
			invite => {
				if (!this.isCurrentRoom(roomId, principalId)) {
					return;
				}
				this.setState("connected", { roomId, principalId, canManageMembers: true, message: `Access token rotated for ${invite.displayName}` });
				this.showInvitation(invite);
				this.refreshMembers();
			},
			error => {
				if (!this.isCurrentRoom(roomId, principalId)) {
					return;
				}
				this.setState("connected", {
					roomId,
					principalId,
					canManageMembers: true,
					message: error instanceof Error ? error.message : "Collaboration credential could not be rotated",
				});
			},
		);
	}

	private revokeMember(member: DocumentCollaborationMember): void {
		if (this._state !== "connected" || !this.roomId || !this.canManageMembers || member.principalId === this.principalId) return;
		if (this.element.ownerDocument.defaultView?.confirm(`Revoke ${member.displayName}'s room access?`) !== true) return;
		const roomId = this.roomId;
		const principalId = this.principalId;
		void this.options.onRevokeMember(member.principalId).then(
			() => {
				if (!this.isCurrentRoom(roomId, principalId)) {
					return;
				}
				this.setState("connected", { roomId, principalId, canManageMembers: true, message: `Access revoked for ${member.displayName}` });
				this.refreshMembers();
			},
			error => {
				if (!this.isCurrentRoom(roomId, principalId)) {
					return;
				}
				this.setState("connected", {
					roomId,
					principalId,
					canManageMembers: true,
					message: error instanceof Error ? error.message : "Collaboration member could not be revoked",
				});
			},
		);
	}

	private requestInviteRole(): DocumentCollaborationRoomRole | undefined {
		const entered = this.element.ownerDocument.defaultView?.prompt("Enter the collaborator role: owner, editor, or viewer.", "editor");
		if (entered == null) return undefined;
		const role = entered.trim().toLowerCase();
		if (role === "owner" || role === "editor" || role === "viewer") return role;
		if (this.roomId) this.setState("connected", { roomId: this.roomId, principalId: this.principalId, canManageMembers: true, message: "Collaboration role must be owner, editor, or viewer" });
		return undefined;
	}

	private showInvitation(invite: DocumentCollaborationInvite): void {
		this.invitationToken.textContent = `Room ID: ${invite.roomId}\nAccess token: ${invite.accessToken}`;
		this.invitation.hidden = false;
	}

	private clearInvitation(): void {
		this.invitationToken.textContent = "";
		this.invitation.hidden = true;
	}

	private clearMembers(): void {
		this.memberActionListeners.clear();
		this.memberList.replaceChildren();
		this.members.hidden = true;
	}
}

function createAction(id: string, label: string, tooltip: string, enabled: boolean, checked: boolean, run: () => void): IAction {
	return { id, label, tooltip, icon: Lxicon.agent, enabled, checked, run };
}

const emptyCollaborationContextMenuProvider: IContextMenuProvider = {
	showContextMenu(): never {
		throw new Error("Document collaboration toolbar does not define secondary actions");
	},
};
