import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IProcessService } from '../../../../platform/process/common/process.js';
import { IIssueFormService } from '../common/issue.js';
import { IssueReporterService } from './issueReporterService.js';

registerSingleton(IIssueFormService, IssueReporterService, InstantiationType.Delayed);
CommandsRegistry.register('_issues.getSystemStatus', accessor => accessor.get(IProcessService).getSystemStatus());
