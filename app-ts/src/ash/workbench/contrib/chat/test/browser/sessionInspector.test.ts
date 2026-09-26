import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { Emitter } from "../../../../../base/common/event.js";
import type { AgentTreeNode, ISession } from "../../../../../sessions/services/sessions/common/session.js";
import type { ISessionsManagementService } from "../../../../../sessions/services/sessions/common/sessionsManagement.js";
import type { TurnChangeDetails, TurnChangeSetSummary } from "../../../../services/chat/common/chatService.js";
import type { ChatWidgetModel } from "../../browser/widget/chatWidgetModel.js";
import { SessionInspector } from "../../browser/view/sessionInspector.js";
import { DialogResult, type IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';

const testDialogs: IDialogService = {
	showMessage: async () => {},
	confirm: async () => ({ confirmed: true }),
	prompt: async () => DialogResult.Cancel,
	input: async () => ({ confirmed: false }),
};

test("Session Inspector isolates Thread changes and enforces open, sealed, draft, and dependency state", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const selected: string[] = [];
	const sessions = { selectThread: (_sessionId: string, threadId: string) => selected.push(threadId) } as unknown as ISessionsManagementService;
	using inspector = new SessionInspector(dom.window.document.body, sessions, { close() {} }, testDialogs);

	const first = modelFixture("thread-a", [changeSet("open", { captureState: "open", revision: 1 })]);
	inspector.bind(first.model);
	assert.match(inspector.element.textContent ?? "", /open · running · 2 files/);
	assert.equal(inspector.element.querySelector<HTMLButtonElement>("[aria-label='Commit this sealed ChangeSet']")?.disabled, true);
	inspector.element.querySelector<HTMLButtonElement>("[aria-label='Open Child Thread']")?.click();
	assert.deepEqual(selected, ["thread-child"]);

	first.setChanges([changeSet("sealed", { captureState: "sealed", revision: 2 })]);
	const draft = inspector.element.querySelector<HTMLTextAreaElement>("textarea");
	const commit = inspector.element.querySelector<HTMLButtonElement>("[aria-label='Commit this sealed ChangeSet']");
	assert.equal(draft?.value, "feat: sealed change");
	assert.equal(commit?.disabled, false);

	first.setChanges([changeSet("blocked", { captureState: "sealed", revision: 3, dependencies: ["previous"] })]);
	assert.equal(inspector.element.querySelector<HTMLButtonElement>("[aria-label='Commit this sealed ChangeSet']")?.disabled, true);
	assert.match(inspector.element.textContent ?? "", /Depends on previous/);

	const second = modelFixture("thread-b", [changeSet("other", { captureState: "sealed", revision: 1 })]);
	inspector.bind(second.model);
	assert.doesNotMatch(inspector.element.textContent ?? "", /blocked/);
	assert.match(inspector.element.textContent ?? "", /other · sealed/);
	dom.window.close();
});

test('Session Inspector discards changes only after confirmation', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	let discarded = 0;
	let confirmed = false;
	const dialogs: IDialogService = { ...testDialogs, confirm: async () => ({ confirmed }) };
	const { model } = modelFixture('thread-a', [changeSet('sealed', { captureState: 'sealed', revision: 1 })]);
	(model as unknown as { discardChanges: () => Promise<void> }).discardChanges = async () => { discarded += 1; };
	using inspector = new SessionInspector(dom.window.document.body, {} as ISessionsManagementService, { close() {} }, dialogs);
	inspector.bind(model);
	const discard = inspector.element.querySelector<HTMLButtonElement>('[aria-label="Discard every uncommitted change in this Thread"]');
	assert.ok(discard);
	discard.click();
	await Promise.resolve();
	assert.equal(discarded, 0);
	confirmed = true;
	discard.click();
	await Promise.resolve();
	assert.equal(discarded, 1);
	dom.window.close();
});

function modelFixture(threadId: string, initial: readonly TurnChangeSetSummary[]): { readonly model: ChatWidgetModel; readonly setChanges: (next: readonly TurnChangeSetSummary[]) => void } {
	const changed = new Emitter<void>();
	let changes = initial;
	const root: AgentTreeNode = {
		threadId,
		threadSequence: 1,
		title: "Root Thread",
		origin: { type: "root" },
		membershipStatus: "active",
		executionStatus: "idle",
		usage: { inputTokens: 0, outputTokens: 0 },
		joins: [],
		children: [{
			threadId: "thread-child",
			threadSequence: 1,
			title: "Child Thread",
			origin: { type: "agentSpawn", parentThreadId: threadId, parentSequence: 1, delegationId: "delegation-1" },
			membershipStatus: "active",
			executionStatus: "running",
			usage: { inputTokens: 0, outputTokens: 0 },
			joins: [],
			children: [],
		}],
	};
	const session = {
		sessionId: "session-1",
		title: "Session",
		status: "active",
		nextApprovalMode: "askPermissions",
		chats: [
			{ threadId, status: "active", origin: { type: "root" } },
			{ threadId: "thread-child", status: "active", origin: root.children[0]!.origin },
		],
		agentTree: [root],
	} as ISession;
	const details = (changeSetId: string): TurnChangeDetails | undefined => {
		const summary = changes.find((candidate) => candidate.changeSetId === changeSetId);
		return summary ? {
			summary,
			files: [{ path: "src/main.ts", kind: "modified", binary: false, additions: 2, deletions: 1 }],
			draftMessage: "feat: sealed change",
		} : undefined;
	};
	const model = {
		onDidChange: changed.event,
		session,
		threadId,
		thread: {
			sessionId: "session-1",
			threadId,
			title: "Thread",
			status: "active",
			sequence: 1,
			usage: emptyUsage(),
			turns: [{
				turnId: "turn-plan",
				status: "completed",
				approvalMode: "askPermissions",
				usage: emptyUsage(),
				items: [],
				plan: { steps: [{ step: "Inspect changes", status: "completed" }] },
			}],
		},
		get changeSets() { return changes; },
		turnChangeDetails: details,
		generateChangeMessage: async () => undefined,
		updateChangeDraft: async () => undefined,
		commitChange: async () => undefined,
		discardChanges: async () => undefined,
	} as unknown as ChatWidgetModel;
	return { model, setChanges: (next) => { changes = next; changed.fire(); } };
}

function changeSet(id: string, overrides: Partial<TurnChangeSetSummary>): TurnChangeSetSummary {
	return {
		changeSetId: id,
		sessionId: "session-1",
		threadId: "thread-a",
		turnId: id,
		repositoryId: "repository",
		targetBranch: "main",
		statistics: { files: 2, additions: 3, deletions: 1 },
		captureState: "sealed",
		messageState: "ready",
		commitState: "idle",
		dependencies: [],
		externalDependencyPaths: [],
		warnings: [],
		conflictPaths: [],
		revision: 1,
		...overrides,
	};
}

function emptyUsage() {
	return {
		modelInvocations: 0,
		inputTokens: { reported: 0, complete: true },
		outputTokens: { reported: 0, complete: true },
		cachedInputTokens: { reported: 0, complete: true },
		cacheWriteInputTokens: { reported: 0, complete: true },
		reasoningTokens: { reported: 0, complete: true },
	};
}
