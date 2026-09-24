import type { FsCreateFileParams, FsDeleteParams, FsGetMetadataParams, FsGetMetadataResult, FsReadBinaryFileParams, FsReadBinaryFileResult, FsReadDirectoryParams, FsReadDirectoryResult, FsReadFileParams, FsReadFileResult, FsRenameParams, FsWriteFileParams, FsWriteFileResult } from "../../app-server/common/generated/index.js";

export interface IFileApi {
	getMetadata(params: FsGetMetadataParams): Promise<FsGetMetadataResult>;
	readDirectory(params: FsReadDirectoryParams): Promise<FsReadDirectoryResult>;
	readFile(params: FsReadFileParams): Promise<FsReadFileResult>;
	readBinaryFile(params: FsReadBinaryFileParams): Promise<FsReadBinaryFileResult>;
	writeFile(params: FsWriteFileParams): Promise<FsWriteFileResult>;
	createFile(params: FsCreateFileParams): Promise<FsGetMetadataResult>;
	rename(params: FsRenameParams): Promise<void>;
	delete(params: FsDeleteParams): Promise<void>;
}
