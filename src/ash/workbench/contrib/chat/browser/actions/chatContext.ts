import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { CancellationTokenSource, type CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { createUuid } from '../../../../../base/common/uuid.js';
import { isWeb } from '../../../../../base/common/platform.js';
import type { Icon } from '../../../../../base/common/icon.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { GitHubIssueState, IGitHubService, type GitHubRepository } from '../../../../../platform/github/common/githubService.js';
import { filterQuickPickItems } from '../../../../../platform/quickinput/browser/quickInputList.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';
import { IChatService } from '../../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IGitService } from '../../../git/common/gitService.js';

export interface ChatContextSource {
	readonly label: string;
	readonly icon: Icon;
	asAttachment(signal: AbortSignal): Promise<ChatContextAttachment | undefined>;
}

export class ClipboardImageContextValuePick implements ChatContextSource {
	public readonly icon = Lxicon.image;
	public get label(): string { return localize('chat.context.clipboardImage', 'Image from Clipboard'); }
	constructor(@IClipboardService private readonly clipboard: IClipboardService) { }
	public async asAttachment(signal: AbortSignal): Promise<ChatContextAttachment | undefined> {
		const image = await this.clipboard.readImage();
		if (signal.aborted) return undefined;
		if (!image.length) throw new Error(localize('chat.context.noClipboardImage', 'The clipboard does not contain an image'));
		return imageAttachment(localize('chat.context.pastedImage', 'Pasted Image'), image);
	}
}

export class ScreenshotContextValuePick implements ChatContextSource {
	public readonly icon = Lxicon.openPreview;
	public get label(): string { return isWeb ? localize('chat.context.screenshotWeb', 'Screenshot…') : localize('chat.context.screenshot', 'Screenshot Window'); }
	constructor(@IHostService private readonly host: IHostService) { }
	public async asAttachment(signal: AbortSignal): Promise<ChatContextAttachment | undefined> {
		const image = await this.host.getScreenshot();
		if (!image || signal.aborted) return undefined;
		return imageAttachment(localize('chat.context.screenshotName', 'Screenshot'), image);
	}
}

export class SessionReferenceContextPickerPick implements ChatContextSource {
	public readonly icon = Lxicon.chat4;
	public get label(): string { return localize('chat.context.sessions', 'Sessions…'); }
	constructor(
		private readonly current: { readonly sessionId: string; readonly threadId: string; } | undefined,
		@IChatSessionNavigationService private readonly navigation: IChatSessionNavigationService,
		@IChatService private readonly chat: IChatService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
	) { }
	public async asAttachment(signal: AbortSignal): Promise<ChatContextAttachment | undefined> {
		const conversations = this.navigation.getConversations().filter(item => !this.current || item.sessionId !== this.current.sessionId || item.threadId !== this.current.threadId);
		const selected = await pickItem(this.quickInput, localize('chat.context.selectSession', 'Select a session'),
			async query => filterQuickPickItems(conversations.map(conversation => ({ label: conversation.title, conversation })), query), signal);
		if (!selected || signal.aborted) return undefined;
		const { sessionId, threadId, title } = selected.conversation;
		// Chat owns transcript reads. No subscription or second session catalog is created for an attachment.
		const snapshot = await this.chat.readThread(sessionId, threadId);
		if (signal.aborted) return undefined;
		const messages = snapshot.transcript.entries.flatMap(entry => {
			if (entry.type !== 'item' || entry.transient) return [];
			const item = entry.item;
			if (item.type === 'userMessage') return [`User: ${item.text}`];
			if (item.type === 'agentMessage') return [`Assistant: ${item.text}`];
			return [];
		}).join('\n\n');
		const content = `Conversation: ${title}\nSession: ${sessionId}\nThread: ${threadId}\n\n${messages.length > 100_000 ? `[Earlier messages omitted]\n${messages.slice(-100_000)}` : messages}`;
		return { id: `session:${sessionId}:${threadId}`, kind: 'sessionReference', name: title, resolve: async () => ({ name: title, content }) };
	}
}

interface RepositoryPick extends IQuickPickItem {
	readonly repository: GitHubRepository;
	readonly number?: number;
}
interface GitHubPick extends IQuickPickItem {
	readonly number?: number;
	readonly nextPage?: number;
}

export class GitHubContextValuePick implements ChatContextSource {
	public get icon(): Icon { return this.kind === 'issue' ? Lxicon.circleLarge : Lxicon.gitPullRequest; }
	public get label(): string { return this.kind === 'issue' ? localize('chat.context.issue', 'Issue…') : localize('chat.context.pullRequest', 'Pull Request…'); }
	constructor(
		private readonly kind: 'issue' | 'pullRequest',
		@IGitHubService private readonly github: IGitHubService,
		@IGitService private readonly git: IGitService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
	) { }

	public async asAttachment(signal: AbortSignal): Promise<ChatContextAttachment | undefined> {
		using resources = new DisposableStore();
		const cancellation = new CancellationTokenSource();
		resources.add(toDisposable(() => cancellation.dispose(true)));
		resources.add(addDisposableListener(signal, 'abort', () => cancellation.cancel()));
		if (signal.aborted) return undefined;
		const accounts = (await this.github.listAccounts(cancellation.token)).filter(account => account.status === 'ready');
		if (signal.aborted) return undefined;
		if (!accounts.length) throw new Error(localize('chat.context.githubSignIn', 'Connect a GitHub account in Settings to attach an issue or pull request'));
		const account = accounts.length === 1 ? accounts[0] : (await pickItem(this.quickInput, localize('chat.context.githubAccount', 'Select a GitHub account'),
			async query => filterQuickPickItems(accounts.map(account => ({ label: account.login, description: account.host, account })), query), signal))?.account;
		if (!account || signal.aborted) return undefined;
		const repositories: RepositoryPick[] = [];
		const seen = new Set<string>();
		for (const checkout of await this.git.listRepositories()) {
			if (signal.aborted) return undefined;
			const graph = await this.git.graph({ limit: 1 }, checkout.id);
			for (const remote of graph.remotes) {
				const identity = remote.identity;
				if (!identity || identity.provider !== 'github' || identity.host.toLowerCase() !== account.host.toLowerCase()) continue;
				const key = `${identity.owner}/${identity.repository}`;
				if (seen.has(key.toLowerCase())) continue;
				seen.add(key.toLowerCase());
				repositories.push({ label: key, description: `${checkout.label} · ${remote.name}`, repository: { accountId: account.id, host: account.host, owner: identity.owner, name: identity.repository } });
			}
		}
		const selected = await pickItem(this.quickInput, localize('chat.context.githubRepository', 'Select a repository, enter owner/repository, or paste a GitHub link'), async query => {
			const picks = [...filterQuickPickItems(repositories, query)];
			const typed = this.repositoryPick(query, account.host, account.id);
			if (typed && !picks.some(pick => pick.label === typed.label && pick.number === typed.number)) picks.unshift(typed);
			return picks;
		}, signal);
		if (!selected || signal.aborted) return undefined;
		const repository = selected.repository;
		let number = selected.number;
		if (number === undefined) {
			let queryValue: string | undefined;
			let page = 1;
			let nextPage: number | null = null;
			let items: GitHubPick[] = [];
			const picked = await pickItem<GitHubPick>(this.quickInput, this.kind === 'issue' ? localize('chat.context.selectIssue', 'Search issues or enter #number') : localize('chat.context.selectPullRequest', 'Search pull requests or enter #number'), async (query, token) => {
				if (queryValue !== query) { queryValue = query; page = 1; items = []; }
				if (/^#?[1-9]\d*$/.test(query.trim())) {
					const number = Number(query.trim().replace(/^#/, ''));
					if (!Number.isSafeInteger(number)) return [];
					const item = this.kind === 'issue' ? await this.github.readIssue(repository, number, token) : await this.github.readPullRequest(repository, number, token);
					return [{ label: `#${item.number} ${item.title}`, description: item.state, number: item.number }];
				}
				const result = this.kind === 'issue' ? await this.github.listIssues(repository, GitHubIssueState.Open, query, page, token) : await this.github.listPullRequests(repository, GitHubIssueState.Open, page, token);
				if (token.isCancellationRequested) return [];
				nextPage = result.nextPage;
				items.push(...result.items.map(item => ({ label: `#${item.number} ${item.title}`, description: item.state, number: item.number })));
				// Issue search also matches body text on GitHub; filtering those results by title loses valid matches.
				return [...(this.kind === 'issue' ? items : filterQuickPickItems(items, query)), ...(nextPage ? [{ label: localize('chat.context.loadMore', 'Load more'), nextPage, alwaysShow: true }] : [])];
			}, signal, item => {
				if (!item.nextPage) return true;
				page = item.nextPage;
				return false;
			});
			number = picked?.number;
		}
		if (number === undefined || signal.aborted) return undefined;
		let name: string;
		let content: string;
		let url: string;
		if (this.kind === 'issue') {
			const issue = await this.github.readIssue(repository, number, cancellation.token);
			name = `${repository.owner}/${repository.name} #${number}: ${issue.title}`;
			url = issue.url;
			content = `Issue: ${name}\nURL: ${url}\nState: ${issue.state}\n\n${issue.body}\n\n${issue.comments.map(comment => `Comment: ${comment.body}`).join('\n\n')}`;
		} else {
			const pr = await this.github.readPullRequest(repository, number, cancellation.token);
			const files = await this.github.listPullRequestFiles(repository, number, 1, cancellation.token);
			name = `${repository.owner}/${repository.name} #${number}: ${pr.title}`;
			url = pr.url;
			content = `Pull request: ${name}\nURL: ${url}\nState: ${pr.state}\nBranches: ${pr.headBranch} → ${pr.baseBranch}\nCommit: ${pr.headCommit}\n\n${pr.body}\n\n${files.items.map(file => `${file.status}: ${file.filename}\n${file.patch ?? ''}`).join('\n\n')}`;
			if (files.nextPage || files.limitReached) content += '\n[Additional changed files omitted]';
		}
		if (signal.aborted) return undefined;
		if (content.length > 100_000) content = `${content.slice(0, 100_000)}\n[Additional content omitted]`;
		return { id: `github:${url}`, kind: this.kind, name, resolve: async () => ({ name, content }) };
	}

	private repositoryPick(query: string, host: string, accountId: string): RepositoryPick | undefined {
		let path = query.trim();
		if (path.startsWith('https://')) {
			try {
				const url = new URL(path);
				if (url.host.toLowerCase() !== host.toLowerCase() || url.username || url.password || url.search || url.hash) return undefined;
				path = url.pathname.replace(/^\//, '').replace(/\/$/, '');
			} catch { return undefined; }
		}
		const match = /^([\w.-]+)\/([\w.-]+)(?:\/(issues|pull)\/([1-9]\d*))?$/.exec(path);
		if (!match || match[3] && match[3] !== (this.kind === 'issue' ? 'issues' : 'pull')) return undefined;
		const number = match[4] ? Number(match[4]) : undefined;
		if (number !== undefined && !Number.isSafeInteger(number)) return undefined;
		return { label: path, repository: { host, accountId, owner: match[1], name: match[2].replace(/\.git$/, '') }, number };
	}
}

function imageAttachment(name: string, bytes: Uint8Array): ChatContextAttachment {
	if (![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) throw new Error(localize('chat.context.invalidImage', 'The image must contain PNG data'));
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
	const content = `data:image/png;base64,${btoa(binary)}`;
	return { id: createUuid(), kind: 'image', name, resolve: async () => ({ name, content, kind: 'image' }) };
}

function pickItem<T extends IQuickPickItem>(quickInput: IQuickInputService, placeholder: string, provide: (query: string, token: CancellationToken) => Promise<readonly T[]>, signal: AbortSignal, accept: (item: T) => boolean = () => true): Promise<T | undefined> {
	const resources = new DisposableStore();
	const picker = resources.add(quickInput.createQuickPick<T>());
	const request = resources.add(new MutableDisposable());
	picker.placeholder = placeholder;
	picker.ariaLabel = placeholder;
	picker.filterValue = () => '';
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (item?: T, error?: unknown): void => {
			if (settled) return;
			settled = true;
			if (error) reject(error); else resolve(item);
			resources.dispose();
		};
		const load = async (query: string): Promise<void> => {
			if (settled) return;
			const cancellation = new CancellationTokenSource();
			request.value = toDisposable(() => cancellation.dispose(true));
			const token = cancellation.token;
			picker.items = [];
			picker.busy = true;
			try {
				const items = await provide(query, token);
				if (!settled && !token.isCancellationRequested) picker.items = items;
			} catch (error) {
				if (!settled && !token.isCancellationRequested) finish(undefined, error);
			} finally {
				if (!settled && !token.isCancellationRequested) picker.busy = false;
			}
		};
		resources.add(picker.onDidChangeValue(query => { void load(query); }));
		resources.add(picker.onDidAccept(item => { if (accept(item)) finish(item); else void load(picker.value); }));
		resources.add(picker.onDidHide(() => finish()));
		resources.add(addDisposableListener(signal, 'abort', () => finish()));
		if (signal.aborted) { finish(); return; }
		picker.show();
		void load('');
	});
}
