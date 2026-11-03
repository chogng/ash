import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suite, test } from 'mocha';
import '../../../browser/chat.shared.contribution.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../../nls.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IIssueReporterService } from '../../../../../../platform/issue/common/issue.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { IExtensionService } from '../../../../../services/extensions/common/extensionService.js';
import { IssueFormService } from '../../../../issue/browser/issueFormService.js';
import { WorkbenchIssueService } from '../../../../issue/browser/issueService.js';
import { IIssueFormService, IWorkbenchIssueService } from '../../../../issue/common/issue.js';
import { IChatWidgetService, type IChatWidget } from '../../../browser/chat.js';
import { ChatModelFeedbackSurveyActionId } from '../../../browser/actions/chatModelFeedbackSurveyActions.js';

class Fixture extends Disposable {
	readonly services = this._register(new InstantiationService());
	readonly notices: string[] = [];
	readonly opened: string[] = [];
	disabled = false;
	submissions = 0;
	failOpen = false;
	widget: IChatWidget | undefined = {
		visible: true, threadId: 'thread-1', getFocus: () => undefined,
		model: { inputState: { selectedModel: { provider: 'connection-1', model: 'model-1' } } },
	} as unknown as IChatWidget;
	readonly form: IssueFormService;
	constructor() {
		super();
		this.services.registerInstance(IConfigurationService, { getValue: () => this.disabled } as unknown as IConfigurationService);
		const fixture = this;
		this.services.registerInstance(IChatWidgetService, { get lastFocusedWidget() { return fixture.widget; } } as IChatWidgetService);
		this.services.registerInstance(INotificationService, { info: (text: string) => this.notices.push(text) } as unknown as INotificationService);
		this.services.registerInstance(IEditorService, { openEditor: async (input: { resource: { toString(): string; }; }) => { if (this.failOpen) throw new Error('Editor unavailable'); this.opened.push(input.resource.toString()); } } as unknown as IEditorService);
		this.services.registerInstance(IIssueReporterService, {
			read: async () => ({ reportIssueUrl: 'https://example.invalid/ash/issues', version: 'fixture', os: 'fixture', arch: 'fixture' }),
			searchGitHubIssues: async () => { throw new Error('No search requested'); },
			submitIssue: async () => { this.submissions++; throw new Error('No submission requested'); },
		});
		this.services.registerInstance(IExtensionService, { currentCatalog: { extensions: [], diagnostics: [] } } as unknown as IExtensionService);
		this.form = this._register(this.services.createInstance(IssueFormService));
		this.services.registerInstance(IIssueFormService, this.form);
		this.services.registerInstance(IWorkbenchIssueService, this.services.createInstance(WorkbenchIssueService));
	}
	async run() { await this.services.invokeFunction(CommandsRegistry.getCommand(ChatModelFeedbackSurveyActionId)!); }
}

suite('Ash model feedback from the standard action', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('the actual report owner receives only model metadata and a reviewable draft', async () => {
		using f = new Fixture(); await f.run();
		assert.equal(f.form.state.issueTitle, 'Model feedback: model-1');
		assert.equal(f.form.state.issueBody, 'Connection: connection-1\nModel: model-1\n\nDescribe the model behavior, the expected result, and how to reproduce it.');
		assert.deepEqual(f.opened, ['ash-issue:/report']); assert.equal(f.submissions, 0);
	});
	test('focused completed replies keep their model after the composer switches models', async () => {
		using f = new Fixture();
		f.widget = {
			visible: true, threadId: 'thread-1', getFocus: () => ({ feedbackSource: { threadId: 'thread-1', turnId: 'turn-1' } }), model: {
				inputState: { selectedModel: { provider: 'new-connection', model: 'new-model' } },
				thread: { turns: [{ turnId: 'turn-1', model: { provider: 'original-connection', model: 'original-model' } }] },
			}
		} as unknown as IChatWidget;
		await f.run(); assert.equal(f.form.state.issueTitle, 'Model feedback: original-model'); assert.match(f.form.state.issueBody, /original-connection/u);
	});
	test('an existing issue draft is opened without replacing text or submitting it', async () => {
		using f = new Fixture(); f.form.update({ issueTitle: 'My existing report', issueBody: 'Keep my reproduction steps.' });
		await f.run(); assert.equal(f.form.state.issueTitle, 'My existing report'); assert.equal(f.form.state.issueBody, 'Keep my reproduction steps.');
		assert.equal(f.notices.length, 1); assert.equal(f.submissions, 0); assert.equal(f.opened.length, 1);
	});
	test('a missing reply model is not replaced by a different composer model', async () => {
		using f = new Fixture(); f.widget = { visible: true, threadId: 'thread-2', getFocus: () => ({ feedbackSource: { threadId: 'thread-1', turnId: 'turn-1' } }), model: { inputState: { selectedModel: { provider: 'new', model: 'new' } } } } as unknown as IChatWidget;
		await assert.rejects(f.run(), /known model/u); assert.deepEqual(f.opened, []); assert.equal(f.form.state.issueTitle, '');
	});
	test('AI disablement and an absent widget leave the report state unchanged', async () => {
		using f = new Fixture(); f.disabled = true; await f.run(); f.disabled = false; f.widget = undefined; await f.run();
		assert.deepEqual(f.opened, []); assert.equal(f.form.state.issueTitle, ''); assert.equal(f.submissions, 0);
	});
	test('an editor error retains the generated draft for another attempt', async () => {
		using f = new Fixture(); f.failOpen = true; await assert.rejects(f.run(), /Editor unavailable/u);
		assert.equal(f.form.state.issueTitle, 'Model feedback: model-1'); assert.equal(f.submissions, 0);
	});
	test('Chinese reports parameterize model and connection names', async () => {
		using f = new Fixture(); setNlsMessages('zh-CN', JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/chat.json', 'utf8')));
		try { await f.run(); } finally { resetNlsResolver(); }
		assert.equal(f.form.state.issueTitle, '模型反馈：model-1'); assert.match(f.form.state.issueBody, /连接：connection-1/u); assert.match(f.form.state.issueBody, /复现步骤/u);
	});
});
