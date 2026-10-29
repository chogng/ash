import type {
	AgentCapabilitiesReadResult,
	AgentToolCapabilityDto,
} from '../../../../../../../../.build/protocol/typescript/index.js';
import { createDisconnectedAppServerApi } from '../../../../../../platform/agentHost/browser/appServerApi.js';
import { unavailableOperation } from '../../../../../../platform/renderer/browser/disconnectedHost.js';
import { LanguageModelToolsService } from '../../../browser/tools/languageModelToolsService.js';
import { Event } from '../../../../../../base/common/event.js';

/** Test wire data keeps UI fixtures readable while exercising the production catalog adapter. */
export interface ToolCatalogFixture {
	readonly tools: readonly (Omit<AgentToolCapabilityDto, 'sourceChain'> & {
		readonly sourceDetails: readonly string[];
	})[];
	readonly sourceGroups: AgentCapabilitiesReadResult['sourceGroups'];
	readonly toolSets?: AgentCapabilitiesReadResult['toolSets'];
}

/** The caller or a singleton registration owns the returned service. */
export function createTestLanguageModelToolsService(api: {
	readonly isAvailable: boolean;
	readonly onDidChangeTools?: Event<void>;
	read(): Promise<ToolCatalogFixture>;
}): LanguageModelToolsService {
	return new LanguageModelToolsService(
		{
			isAvailable: api.isAvailable,
			onDidChangeTools: api.onDidChangeTools ?? Event.None,
			read: async () => {
				const catalog = await api.read();
				return {
					tools: catalog.tools.map(({ sourceDetails, ...tool }) => ({
						...tool,
						category: tool.category ?? undefined,
						sourceChain: sourceDetails.map(id => ({ type: 'system' as const, id })),
					})),
					sourceGroups: catalog.sourceGroups,
					toolSets: catalog.toolSets ?? [],
					profiles: [],
				};
			},
		},
		createDisconnectedAppServerApi(unavailableOperation),
	);
}
