import {
  createQadam,
} from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { readFile } from './lib/actions/read-file';
import { amazons3UploadFile } from './lib/actions/upload-file';
import { newFile } from './lib/triggers/new-file';
import { generateSignedUrl } from './lib/actions/generate-signed-url';
import { generateSignedUploadUrl } from './lib/actions/generate-signed-upload-url';
import { moveFile } from './lib/actions/move-file';
import { deleteFile } from './lib/actions/delete-file';
import { listFiles } from './lib/actions/list-files';
import { decryptPgpFile } from './lib/actions/decrypt-pgp-file';
import { amazonS3Auth } from './lib/auth';

export const amazonS3 = createQadam({
  displayName: 'Amazon S3',
  description: 'Scalable storage in the cloud',

  logoUrl: '/assets/qadams/amazon-s3.png',
  minimumSupportedRelease: '0.30.0',
  authors: ["Willianwg", "kishanprmr", "MoShizzle", "AbdulTheActivePiecer", "khaledmashaly", "abuaboud", "Kevinyu-alan", "hugh-codes"],
  categories: [QadamCategory.DEVELOPER_TOOLS],
  auth: amazonS3Auth,
  actions: [amazons3UploadFile, readFile, generateSignedUrl, generateSignedUploadUrl, moveFile, deleteFile, listFiles, decryptPgpFile],
  triggers: [newFile],
});
