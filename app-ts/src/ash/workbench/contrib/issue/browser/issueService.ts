import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IIssueFormService, type IWorkbenchIssueService, type IssueReporterData } from '../common/issue.js';

export const issueReporterEditorId = 'workbench.editor.issueReporter';

export class WorkbenchIssueService implements IWorkbenchIssueService {
	constructor(@IEditorService private readonly editorService: IEditorService, @IIssueFormService private readonly formService: IIssueFormService) { }

	async openReporter(data: Partial<IssueReporterData> = {}): Promise<void> {
		if (typeof data !== 'object' || data === null || Array.isArray(data)) { throw new TypeError('Issue reporter arguments must be an object'); }
		if (Object.keys(data).some(key => !['issueType', 'issueTitle', 'issueBody'].includes(key))) { throw new TypeError('Issue reporter arguments support only issueType, issueTitle and issueBody'); }
		this.formService.update(data);
		void this.formService.initialize({});
		await this.editorService.openEditor({ resource: URI.parse('ash-issue:/report'), label: localize('issue.title', 'Report an issue'), readOnly: true, showBreadcrumbs: false });
	}
}
