import type { TypstCompileParams, TypstCompileResult } from "../../app-server/common/generated/index.js";

export interface ITypstApi {
	compile(params: TypstCompileParams): Promise<TypstCompileResult>;
}
