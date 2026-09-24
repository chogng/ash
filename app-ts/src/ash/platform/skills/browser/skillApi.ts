import type { UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import type { AppServerProtocolClient } from "../../app-server/browser/appServerProtocolClient.js";
import { appServerRequest } from "../../app-server/browser/appServerRequest.js";
import type { ISkillService } from "../common/skillService.js";
import { generateUuid } from "../../../base/common/uuid.js";
import { normalizeSkillCatalog } from "../common/skillApi.js";

export function createDisconnectedSkillApi(unavailable: UnavailableOperation): ISkillService {
	return { list: () => unavailable("skills.list"), read: () => unavailable("skills.read"), setEnabled: () => unavailable("skills.setEnabled") };
}

export function createAppServerSkillApi(connection: AppServerProtocolClient): ISkillService {
	return {
		list: async (reload) => normalizeSkillCatalog(await appServerRequest(connection, "skills/list", { reload })),
		read: async () => {
			const [config, catalog] = await Promise.all([appServerRequest(connection, "config/read", {}), appServerRequest(connection, "skills/list", { reload: "refresh" })]);
			return { revision: config.revision, catalog: normalizeSkillCatalog(catalog), diagnostics: catalog.diagnostics.map(entry => ({ source: entry.source, subject: entry.subject ?? undefined, message: entry.message })) };
		},
		setEnabled: async (skillId, enabled, expectedRevision) => {
			await appServerRequest(connection, "skill/enablement/set", { commandId: generateUuid(), expectedRevision, skillId, enablement: enabled ? "enabled" : "disabled" });
		},
	};
}
