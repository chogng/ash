import type { FsCopyParams, FsCreateDirectoryParams, FsCreateFileParams, FsDeleteParams, FsGetMetadataParams, FsGetMetadataResult, FsPasteSystemCutFilesParams, FsReadBinaryFileParams, FsReadBinaryFileResult, FsReadDirectoryParams, FsReadDirectoryResult, FsReadFileParams, FsReadFileResult, FsRenameParams, FsWriteBinaryFileParams, FsWriteFileParams, FsWriteFileResult } from "../../app-server/common/generated/index.js";

export interface IFileApi {
	getMetadata(params: FsGetMetadataParams): Promise<FsGetMetadataResult>;
	readDirectory(params: FsReadDirectoryParams): Promise<FsReadDirectoryResult>;
	readFile(params: FsReadFileParams): Promise<FsReadFileResult>;
	readBinaryFile(params: FsReadBinaryFileParams): Promise<FsReadBinaryFileResult>;
	writeFile(params: FsWriteFileParams): Promise<FsWriteFileResult>;
	writeBinaryFile(params: FsWriteBinaryFileParams): Promise<FsWriteFileResult>;
	createFile(params: FsCreateFileParams): Promise<FsGetMetadataResult>;
	createDirectory(params: FsCreateDirectoryParams): Promise<FsGetMetadataResult>;
	copy(params: FsCopyParams): Promise<void>;
	pasteSystemCutFiles(params: FsPasteSystemCutFilesParams): Promise<boolean>;
	rename(params: FsRenameParams): Promise<void>;
	delete(params: FsDeleteParams): Promise<void>;
}
