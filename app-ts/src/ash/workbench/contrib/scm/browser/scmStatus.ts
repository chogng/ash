import { lxiconsLibrary } from "../../../../base/common/lxiconsLibrary.js";
import { Disposable, MutableDisposable } from "../../../../base/common/lifecycle.js";
import type { IWorkbenchContribution } from "../../../common/contributions.js";
import type { GitHead, GitStatus, IGitService } from "../../../services/git/common/gitService.js";
import { StatusbarAlignment, type IStatusbarEntry, type IStatusbarEntryAccessor, type IStatusbarService } from "../../../services/statusbar/browser/statusbar.js";
import type { IViewsService } from "../../../services/views/browser/viewsService.js";

const BranchPriority = 900;
const SyncPriority = 800;
const ScmCompactGroup = "ash.status.git";

export interface ScmStatusContributionOptions {
	readonly statusbarService: IStatusbarService;
	readonly gitService: IGitService;
	readonly viewsService: IViewsService;
}

/** Projects the active Git branch and upstream state into the status bar. */
export class ScmStatusContribution extends Disposable implements IWorkbenchContribution {
	private readonly branch = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly sync = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly retiredGitStreams = new Set<string>();
	private gitStatus: GitStatus | undefined;
	private refreshRevision = 0;

	constructor(private readonly options: ScmStatusContributionOptions) {
		super();
		this._register(options.gitService.onDidChangeStatus(status => {
			this.refreshRevision += 1;
			this.acceptStatus(status);
		}));
		this._register(options.gitService.onDidBecomeReady(() => this.refresh()));
		this.refresh();
	}

	private refresh(): void {
		const revision = ++this.refreshRevision;
		void this.options.gitService.status().then(status => {
			if (!this.isDisposed && revision === this.refreshRevision) this.acceptStatus(status);
		}).catch(() => undefined);
	}

	private acceptStatus(status: GitStatus): void {
		if (this.gitStatus) {
			if (status.streamInstanceId === this.gitStatus.streamInstanceId) {
				if (status.revision <= this.gitStatus.revision) return;
			} else {
				if (this.retiredGitStreams.has(status.streamInstanceId)) return;
				this.retiredGitStreams.add(this.gitStatus.streamInstanceId);
			}
		}
		this.gitStatus = status;
		const focusGit = () => this.options.viewsService.focusView("ash.gitView");
		this.updateOrAdd(this.branch, branchEntry(status.head, focusGit), "ash.status.git.branch", BranchPriority);
		this.updateOrAdd(this.sync, syncEntry(status.head, focusGit), "ash.status.git.sync", SyncPriority);
	}

	private updateOrAdd(slot: MutableDisposable<IStatusbarEntryAccessor>, entry: IStatusbarEntry, id: string, priority: number): void {
		if (slot.value) {
			slot.value.update(entry);
			return;
		}
		slot.value = this.options.statusbarService.addEntry(entry, { id, alignment: StatusbarAlignment.Left, priority, compactGroup: ScmCompactGroup });
	}
}

function branchEntry(head: GitHead, run: () => unknown): IStatusbarEntry {
	switch (head.type) {
		case "branch": return { icon: lxiconsLibrary.gitBranch, text: head.name, ariaLabel: `Git branch ${head.name}`, tooltip: head.upstream ? `${head.name} tracks ${head.upstream.name}` : `${head.name} has no upstream`, run };
		case "unborn": return { icon: lxiconsLibrary.gitBranch, text: head.name, ariaLabel: `Unborn Git branch ${head.name}`, tooltip: `${head.name} has no commits`, run };
		case "detached": {
			const revision = head.objectId.slice(0, 8);
			return { icon: lxiconsLibrary.gitCommit, text: revision, ariaLabel: `Detached Git HEAD at ${revision}`, tooltip: `Detached HEAD at ${head.objectId}`, run };
		}
	}
}

function syncEntry(head: GitHead, run: () => unknown): IStatusbarEntry {
	if (head.type !== "branch") return { icon: lxiconsLibrary.sync, text: "", ariaLabel: "No Git branch to synchronize", tooltip: "No Git branch to synchronize", run };
	if (!head.upstream) return { icon: lxiconsLibrary.repoPush, text: "", ariaLabel: `Publish Git branch ${head.name}`, tooltip: `${head.name} has no upstream`, run };
	const { ahead, behind, name } = head.upstream;
	const text = ahead === 0 && behind === 0 ? "" : `${behind}↓ ${ahead}↑`;
	const summary = `${behind} incoming and ${ahead} outgoing ${ahead + behind === 1 ? "change" : "changes"}`;
	return { icon: lxiconsLibrary.sync, text, ariaLabel: `Synchronize Git changes, ${summary}`, tooltip: `Synchronize Changes with ${name}: ${summary}`, run };
}
