import type { TypstCompileParams, TypstCompileResult } from "../../../../../crates/app-server-protocol/schema/typescript/index.js";

export interface ITypstApi {
	compile(params: TypstCompileParams): Promise<TypstCompileResult>;
}
