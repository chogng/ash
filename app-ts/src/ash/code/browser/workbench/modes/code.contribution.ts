import '../../../../workbench/contrib/call/browser/call.contribution.js';
import "../../../../workbench/contrib/automation/browser/automation.contribution.js";
import "../../../../editor/editor.code.all.js";
import '../../../../editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.js';
import "../../../../workbench/contrib/codeEditor/browser/codeEditor.contribution.js";
import "../../../../workbench/contrib/debug/browser/debug.contribution.js";
import "../../../../workbench/contrib/tasks/browser/tasks.contribution.js";
import "../../../../workbench/contrib/testing/browser/testing.contribution.js";
import "../codeWorkbenchServices.js";
import { ISyntaxApi } from "../../../../platform/syntax/common/syntaxApi.js";
import { ILanguageFeaturesService } from "../../../../editor/common/services/languageFeatures.js";
import { registerWorkbenchContribution, WorkbenchPhase } from "../../../../workbench/common/contributions.js";
import { AppServerSyntaxProviders } from "../../../../workbench/services/language/browser/appServerSyntaxProviders.js";

registerWorkbenchContribution(
	"code.contrib.appServerSyntax",
	WorkbenchPhase.BlockStartup,
	accessor => new AppServerSyntaxProviders(
		accessor.get(ILanguageFeaturesService),
		accessor.get(ISyntaxApi),
	),
);
