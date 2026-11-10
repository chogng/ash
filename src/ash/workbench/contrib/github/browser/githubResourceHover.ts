import './media/githubResourceHover.css';
import { $, addDisposableListener } from '../../../../base/browser/dom.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { renderAsPlaintext } from '../../../../base/browser/markdownRenderer.js';
import { DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import type { ILinkPresentation, ILinkPresentationStatus } from '../../../../platform/dataChannel/common/dataChannel.js';
import type { GitHubCommit, GitHubIssueDetails, GitHubPullRequest, GitHubPullRequestChecks, GitHubPullRequestChecksStatus, GitHubRepositoryInfo } from '../../../../platform/github/common/githubService.js';
import { colorCssVariable } from '../../../../platform/theme/common/colorUtils.js';
import { computeIssueIcon } from '../../../common/chatIssue.js';
import { computePullRequestIcon, type ChatPullRequestState } from '../../../common/chatPullRequest.js';
import type { ThemeIcon } from '../../../../base/common/themables.js';

export interface IGitHubResourceHover extends IDisposable {
	readonly element: HTMLElement;
	readonly tabbableElements: readonly HTMLElement[];
}

interface ResourceHoverData {
	readonly owner: string;
	readonly repo: string;
	readonly repositoryHref: string;
	readonly referenceHref: string;
	readonly density: 'default' | 'compact';
	readonly onDidClickRepository: () => void;
	readonly onDidClickReference: () => void;
}

export interface IIssueResourceHoverData extends ResourceHoverData {
	readonly number: number;
	readonly issue: GitHubIssueDetails;
}

export interface IPullRequestResourceHoverData extends ResourceHoverData {
	readonly number: number;
	readonly pullRequest: GitHubPullRequest;
	readonly checks?: GitHubPullRequestChecks;
	readonly onDidClickBaseBranch: () => void;
	readonly headBranchLink: { readonly href: string; readonly onClick: () => void; } | undefined;
}

export interface ICommitResourceHoverData extends ResourceHoverData {
	readonly commit: GitHubCommit;
}

/** Keeps the card builder beside its resolved metadata without widening the shared link contract. */
export class GitHubResourcePresentation implements ILinkPresentation {
	public readonly kind: ILinkPresentation['kind'];
	public readonly title: string | undefined;
	public readonly detail: string | undefined;
	public readonly reference: string | undefined;
	public readonly status: ILinkPresentationStatus | undefined;
	public readonly secondaryStatus: ILinkPresentationStatus | undefined;
	public readonly isLoading = false;
	public readonly changes: ILinkPresentation['changes'];
	public readonly tooltip: string | undefined;
	public readonly ariaLabel: string | undefined;

	constructor(presentation: ILinkPresentation, public readonly createHover: () => IGitHubResourceHover, public readonly pullRequestIcon?: ThemeIcon) {
		this.kind = presentation.kind;
		this.title = presentation.title;
		this.detail = presentation.detail;
		this.reference = presentation.reference;
		this.status = presentation.status;
		this.secondaryStatus = presentation.secondaryStatus;
		this.changes = presentation.changes;
		this.tooltip = presentation.tooltip;
		this.ariaLabel = presentation.ariaLabel;
	}
}

export function createRepositoryResourceHover(data: ResourceHoverData & { readonly repository: GitHubRepositoryInfo; }): IGitHubResourceHover {
	return resourceHover(data, data.repository.fullName, data.repository.defaultBranch, localize('github.repository', 'Repository'), localize('github.defaultBranch', 'Default branch: {0}', data.repository.defaultBranch));
}

export function createIssueResourceHover(data: IIssueResourceHoverData): IGitHubResourceHover {
	const card = resourceHover(data, data.issue.title, `#${data.number}`, getIssueResourceStatus(data.issue).label, data.issue.body);
	const icon = computeIssueIcon(data.issue.state, data.issue.stateReason);
	const status = card.element.querySelector<HTMLElement>('.ash-github-hover-metadata')!;
	const glyph = appendIcon(icon, status);
	glyph.style.color = `var(${colorCssVariable(icon.color!.id)})`;
	return card;
}

export function createPullRequestResourceHover(data: IPullRequestResourceHoverData): IGitHubResourceHover {
	const state = getPullRequestResourceStatus(data.pullRequest);
	const card = resourceHover(data, data.pullRequest.title, `#${data.number}`, state.label, data.pullRequest.body);
	const icon = computePullRequestIcon(state.kind, { hasMergeConflicts: data.pullRequest.mergeable === false, hasFailingChecks: data.checks?.status === 'failure' });
	const status = card.element.querySelector<HTMLElement>('.ash-github-hover-metadata')!;
	const glyph = appendIcon(icon, status);
	glyph.style.color = `var(${colorCssVariable(icon.color!.id)})`;
	const branches = $('.ash-github-hover-branches');
	card.element.append(branches);
	const base = hoverLink(branches, data.pullRequest.baseBranch, `${data.repositoryHref}/tree/${encodeURIComponent(data.pullRequest.baseBranch)}`, data.onDidClickBaseBranch, card);
	branches.append($('span', undefined, '←'));
	card.tabbableElements.push(base);
	if (data.headBranchLink) {
		const head = hoverLink(branches, data.pullRequest.headBranch, data.headBranchLink.href, data.headBranchLink.onClick, card);
		card.tabbableElements.push(head);
	} else {
		branches.append($('span', undefined, data.pullRequest.headBranch));
	}
	card.element.dataset.githubContent += `\n\n${data.pullRequest.baseBranch} ← ${data.pullRequest.headBranch}`;
	if (data.checks && data.checks.status !== 'neutral') {
		const label = getPullRequestChecksStatusLabel(data.checks.status);
		card.element.append($('span.ash-github-hover-metadata', undefined, label));
		card.element.dataset.githubContent += `\n${label}`;
	}
	const missing = data.checks?.unreportedRequiredChecks;
	if (missing?.length) {
		const label = localize('github.checks.unreportedRequired', 'Waiting for required checks to report: {0}', missing.join(', '));
		card.element.append($('span.ash-github-hover-metadata', undefined, label));
		card.element.dataset.githubContent += `\n${label}`;
	}
	return card;
}

export function createCommitResourceHover(data: ICommitResourceHoverData): IGitHubResourceHover {
	const [title, ...body] = data.commit.message.split('\n');
	const card = resourceHover(data, title, data.commit.sha.slice(0, 7), data.commit.author, body.join('\n'));
	card.element.append($('span.ash-github-hover-metadata', undefined, `${data.commit.committedAt} · +${data.commit.additions} −${data.commit.deletions}`));
	card.element.dataset.githubContent += `\n\n${data.commit.committedAt} · +${data.commit.additions} −${data.commit.deletions}`;
	return card;
}

export function getIssueResourceStatus(issue: GitHubIssueDetails): ILinkPresentationStatus {
	if (issue.state === 'open') {
		return { kind: 'open', label: localize('github.status.open', 'Open') };
	}
	if (issue.stateReason === 'not_planned') {
		return { kind: 'closed', label: localize('github.status.notPlanned', 'Closed as not planned') };
	}
	if (issue.stateReason === 'duplicate') {
		return { kind: 'closed', label: localize('github.status.duplicate', 'Closed as duplicate') };
	}
	return { kind: 'closed', label: localize('github.status.closed', 'Closed') };
}

export function getPullRequestResourceStatus(pullRequest: GitHubPullRequest): ILinkPresentationStatus & { readonly kind: ChatPullRequestState; } {
	if (pullRequest.mergedAt) {
		return { kind: 'merged', label: localize('github.status.merged', 'Merged') };
	}
	if (pullRequest.state === 'closed') {
		return { kind: 'closed', label: localize('github.status.closed', 'Closed') };
	}
	if (pullRequest.draft) {
		return { kind: 'draft', label: localize('github.status.draft', 'Draft') };
	}
	const label = localize('github.status.open', 'Open');
	return { kind: 'open', label: pullRequest.mergeable === false ? `${label} · ${localize('github.mergeConflicts', 'Merge conflicts')}` : label };
}

export function getPullRequestChecksStatusLabel(status: Exclude<GitHubPullRequestChecksStatus, 'neutral'>): string {
	switch (status) {
		case 'pending': return localize('github.checks.pending', 'Checks pending');
		case 'failure': return localize('github.checks.failure', 'Checks failed');
		case 'success': return localize('github.checks.success', 'Checks passed');
	}
}

function resourceHover(data: ResourceHoverData, title: string, reference: string, status: string, body: string): DisposableStore & { readonly element: HTMLElement; readonly tabbableElements: HTMLElement[]; } {
	const store = new DisposableStore();
	const element = $('.ash-github-resource-hover');
	element.classList.toggle('compact', data.density === 'compact');
	const repository = hoverLink(element, `${data.owner}/${data.repo}`, data.repositoryHref, data.onDidClickRepository, store);
	repository.classList.add('ash-github-hover-repository');
	const titleElement = $('.ash-github-hover-title');
	element.append(titleElement);
	const link = hoverLink(titleElement, `${title} · ${reference}`, data.referenceHref, data.onDidClickReference, store);
	link.title = title;
	element.append($('span.ash-github-hover-metadata', undefined, status));
	const text = renderAsPlaintext(body);
	if (text) {
		const description = $('.ash-github-hover-description');
		description.textContent = [...text].length > 200 ? `${[...text].slice(0, 200).join('').trimEnd()}…` : text;
		element.append(description);
	}
	element.dataset.githubContent = [`${data.owner}/${data.repo}`, `${title} · ${reference}`, status, text].join('\n\n');
	return Object.assign(store, { element, tabbableElements: [repository, link] });
}

function hoverLink(container: HTMLElement, label: string, href: string, onClick: () => void, store: DisposableStore): HTMLAnchorElement {
	const link = $('a.ash-github-hover-link') as HTMLAnchorElement;
	link.href = href;
	link.textContent = label;
	container.append(link);
	store.add(addDisposableListener(link, 'click', event => {
		event.preventDefault();
		event.stopPropagation();
		onClick();
	}));
	return link;
}
