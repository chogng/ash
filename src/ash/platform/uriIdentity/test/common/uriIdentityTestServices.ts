import { FileService } from '../../../files/common/fileService.js';
import { IFileService, type IFileService as IFileServiceContract } from '../../../files/common/files.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { IUriIdentityService } from '../../common/uriIdentity.js';
import { UriIdentityService } from '../../common/uriIdentityService.js';

/** Uses the production dependency-injection path; unregistered schemes retain exact path casing. */
export class TestUriIdentityServices extends InstantiationService {
	constructor(files?: IFileServiceContract) {
		super();
		if (files) this.registerInstance(IFileService, files);
		else this.registerSingleton(IFileService, () => this.createInstance(FileService));
		this.registerSingleton(IUriIdentityService, () => this.createInstance(UriIdentityService));
		this.get(IUriIdentityService);
	}
}
