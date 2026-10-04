import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IssueType, type IssueReporterState } from '../common/issue.js';

/** One window owns the draft, including requests that outlive its editor tab. */
export class IssueReporterModel extends Disposable {
	private readonly changeEmitter = this._register(new Emitter<IssueReporterState>());
	readonly onDidChange = this.changeEmitter.event;
	private current: IssueReporterState = {
		issueType: IssueType.Bug, issueTitle: '', issueBody: '', includeSystemInfo: true,
		includeExtensions: true, systemInfo: '', extensionInfo: '', loading: false,
		searching: false, submitting: false, similarIssues: [],
	};

	get state(): IssueReporterState { return this.current; }
	update(data: Partial<IssueReporterState>): void {
		this.current = { ...this.current, ...data };
		this.changeEmitter.fire(this.current);
	}

	serialize(): string {
		const data = this.current;
		const type = [localize('issue.bug', 'Bug'), localize('issue.performance', 'Performance issue'), localize('issue.feature', 'Feature request')][data.issueType];
		const sections = [localize('issue.reportType', 'Type: {0}', type), data.issueBody.trim()];
		if (data.includeSystemInfo) { sections.push(`<details>\n<summary>${localize('issue.systemInformation', 'System information')}</summary>\n\n${data.systemInfo}\n</details>`); }
		if (data.includeExtensions) { sections.push(`<details>\n<summary>${localize('issue.extensions', 'Extensions')}</summary>\n\n${data.extensionInfo}\n</details>`); }
		return sections.join('\n\n');
	}
}
