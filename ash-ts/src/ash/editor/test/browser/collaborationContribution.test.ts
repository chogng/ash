import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { CollaborationContribution } from "../../contrib/collaboration/browser/collaborationContribution.js";

test("Stanza collaboration contribution keeps a newly issued invitation available until its owner dismisses it", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const prompts = ["Writer", "viewer"];
	Object.defineProperty(environment.window, "prompt", { configurable: true, value: () => prompts.shift() ?? null });
	const invitations: { readonly displayName: string; readonly role: string }[] = [];
	using contribution = new CollaborationContribution(environment.window.document.body, {
		onStart: async () => ({ roomId: "unused", principalId: undefined, canManageMembers: false }),
		onStop: () => undefined,
		onInvite: async (displayName, role) => {
			invitations.push({ displayName, role });
			return { roomId: "stanza-room", principalId: "member-1", displayName, role, accessToken: "member-token" };
		},
		onListMembers: async () => [],
		onRotateMemberAccessToken: async () => ({ roomId: "stanza-room", principalId: "member-1", displayName: "Writer", role: "viewer", accessToken: "member-token" }),
		onRevokeMember: async () => undefined,
	});
	environment.window.document.body.append(contribution.element);
	contribution.setState("connected", {
		roomId: "stanza-room",
		canManageMembers: true,
	});

	const invite = contribution.element.querySelector<HTMLButtonElement>("[data-action-id='inviteCollaborator'] button");
	assert.ok(invite);
	invite.click();
	await flushMicrotasks();

	assert.deepEqual(invitations, [{ displayName: "Writer", role: "viewer" }]);
	const credentials = contribution.element.querySelector<HTMLPreElement>(".stanza-document-collaboration-invitation-token");
	assert.equal(credentials?.textContent, "Room ID: stanza-room\nAccess token: member-token");
	assert.equal(credentials?.parentElement?.hidden, false);
	const dismiss = contribution.element.querySelector<HTMLButtonElement>(".stanza-document-collaboration-invitation-dismiss");
	assert.ok(dismiss);
	dismiss.click();
	assert.equal(credentials?.textContent, "");
	assert.equal(credentials?.parentElement?.hidden, true);
	environment.window.close();
});

test("Stanza collaboration contribution lets a room owner inspect, rotate, and revoke other members", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	Object.defineProperty(environment.window, "confirm", { configurable: true, value: () => true });
	const rotations: string[] = [];
	const revocations: string[] = [];
	using contribution = new CollaborationContribution(environment.window.document.body, {
		onStart: async () => ({ roomId: "unused", principalId: undefined, canManageMembers: false }),
		onStop: () => undefined,
		onInvite: async () => ({ roomId: "stanza-room", principalId: "member-1", displayName: "Writer", role: "editor", accessToken: "member-token" }),
		onListMembers: async () => [
			{ principalId: "owner-1", displayName: "Owner", role: "owner" },
			{ principalId: "member-1", displayName: "Writer", role: "editor" },
		],
		onRotateMemberAccessToken: async principalId => {
			rotations.push(principalId);
			return { roomId: "stanza-room", principalId, displayName: "Writer", role: "editor", accessToken: "rotated-token" };
		},
		onRevokeMember: async principalId => {
			revocations.push(principalId);
		},
	});
	environment.window.document.body.append(contribution.element);
	contribution.setState("connected", {
		roomId: "stanza-room",
		principalId: "owner-1",
		canManageMembers: true,
	});

	const manage = contribution.element.querySelector<HTMLButtonElement>("[data-action-id='manageCollaborators'] button");
	assert.ok(manage);
	manage.click();
	await flushMicrotasks();
	const owner = contribution.element.querySelector<HTMLElement>("[data-principal-id='owner-1']");
	const writer = contribution.element.querySelector<HTMLElement>("[data-principal-id='member-1']");
	assert.equal(owner?.querySelector<HTMLButtonElement>("button:last-child")?.disabled, true);
	assert.equal(writer?.textContent, "Writereditor · member-1Rotate tokenRevoke");

	writer?.querySelector<HTMLButtonElement>("button")?.click();
	await flushMicrotasks();
	assert.deepEqual(rotations, ["member-1"]);
	assert.equal(contribution.element.querySelector<HTMLPreElement>(".stanza-document-collaboration-invitation-token")?.textContent, "Room ID: stanza-room\nAccess token: rotated-token");

	const currentWriter = contribution.element.querySelector<HTMLElement>("[data-principal-id='member-1']");
	currentWriter?.querySelector<HTMLButtonElement>("button:last-child")?.click();
	await flushMicrotasks();
	assert.deepEqual(revocations, ["member-1"]);
	environment.window.close();
});

test('Stanza collaboration contribution releases replaced and disposed member actions', async () => {
	const environment = new JSDOM('<!doctype html><body></body>');
	Object.defineProperty(environment.window, 'confirm', { configurable: true, value: () => true });
	const rotations: string[] = [];
	const revocations: string[] = [];
	const contribution = new CollaborationContribution(environment.window.document.body, {
		onStart: async () => ({ roomId: 'unused', principalId: undefined, canManageMembers: false }),
		onStop: () => undefined,
		onInvite: async () => ({ roomId: 'room', principalId: 'member', displayName: 'Writer', role: 'editor', accessToken: 'token' }),
		onListMembers: async () => [{ principalId: 'member', displayName: 'Writer', role: 'editor' }],
		onRotateMemberAccessToken: async principalId => {
			rotations.push(principalId);
			return { roomId: 'room', principalId, displayName: 'Writer', role: 'editor', accessToken: 'token' };
		},
		onRevokeMember: async principalId => { revocations.push(principalId); },
	});
	try {
		contribution.setState('connected', { roomId: 'room', principalId: 'owner', canManageMembers: true });
		const manage = contribution.element.querySelector<HTMLButtonElement>("[data-action-id='manageCollaborators'] button")!;
		manage.click();
		await flushMicrotasks();
		const oldRotate = contribution.element.querySelector<HTMLButtonElement>("[data-principal-id='member'] button")!;
		manage.click();
		await flushMicrotasks();
		const rotate = contribution.element.querySelector<HTMLButtonElement>("[data-principal-id='member'] button")!;
		const revoke = contribution.element.querySelector<HTMLButtonElement>("[data-principal-id='member'] button:last-child")!;
		assert.notStrictEqual(oldRotate, rotate);
		oldRotate.click();
		await flushMicrotasks();
		assert.deepEqual(rotations, []);

		contribution.dispose();
		rotate.click();
		revoke.click();
		await flushMicrotasks();
		assert.deepEqual({ rotations, revocations }, { rotations: [], revocations: [] });
	} finally {
		contribution.dispose();
		environment.window.close();
	}
});

test('Stanza collaboration contribution ignores member results after disposal', async () => {
	const environment = new JSDOM('<!doctype html><body></body>');
	let resolveMembers!: (members: readonly { readonly principalId: string; readonly displayName: string; readonly role: 'editor' }[]) => void;
	const contribution = new CollaborationContribution(environment.window.document.body, {
		onStart: async () => ({ roomId: 'unused', principalId: undefined, canManageMembers: false }),
		onStop: () => undefined,
		onInvite: async () => ({ roomId: 'room', principalId: 'member', displayName: 'Writer', role: 'editor', accessToken: 'token' }),
		onListMembers: () => new Promise(resolve => { resolveMembers = resolve; }),
		onRotateMemberAccessToken: async () => ({ roomId: 'room', principalId: 'member', displayName: 'Writer', role: 'editor', accessToken: 'token' }),
		onRevokeMember: async () => undefined,
	});
	try {
		contribution.setState('connected', { roomId: 'room', principalId: 'owner', canManageMembers: true });
		contribution.element.querySelector<HTMLButtonElement>("[data-action-id='manageCollaborators'] button")?.click();
		contribution.dispose();
		resolveMembers([{ principalId: 'late', displayName: 'Late', role: 'editor' }]);
		await flushMicrotasks();
		assert.equal(contribution.element.querySelector("[data-principal-id='late']"), null);
	} finally {
		contribution.dispose();
		environment.window.close();
	}
});

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}
