import { ICodebaseSymbolsApi } from "../../../../platform/codebaseSymbols/common/codebaseSymbolsApi.js";
import { ICodebaseSymbolsService } from "../../../../platform/codebaseSymbols/common/codebaseSymbolsService.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { registerWorkbenchServiceContribution } from "../../../browser/workbenchServiceContributions.js";
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { AppServerCodebaseSymbolsService } from "./appServerCodebaseSymbolsService.js";
import { registerCodebaseSymbolsWorkspaceSymbolProvider } from "./codebaseSymbolsWorkspaceSymbolProvider.js";

registerWorkbenchServiceContribution({
	service: ICodebaseSymbolsService,
	dependencies: [ICodebaseSymbolsApi, ILanguageFeaturesService, IWorkspaceContextService],
	install: context => {
		const service = new AppServerCodebaseSymbolsService(context.container.get(ICodebaseSymbolsApi));
		context.register(registerCodebaseSymbolsWorkspaceSymbolProvider(context.container.get(ILanguageFeaturesService), service, context.container.get(IWorkspaceContextService)));
		return service;
	},
});
