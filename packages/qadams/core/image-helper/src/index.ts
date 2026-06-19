import { createQadam, QadamAuth } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { imageToBase64 } from './lib/actions/image-to-base64.action';
import { getMetaData } from './lib/actions/get-metadata.action';
import { cropImage } from './lib/actions/crop-image.action';
import { rotateImage } from './lib/actions/rotate-image.action';
import { resizeImage } from './lib/actions/resize-Image.action';
import { compressImage } from './lib/actions/compress-image.actions';

export const imageHelper = createQadam({
  displayName: 'Image Helper',
  description: 'Tools for image manipulations',

  auth: QadamAuth.None(),
  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/new-core/image-helper.svg',
  authors: ["AbdullahBitar","kishanprmr","abuaboud"],
  categories: [QadamCategory.CORE],
  actions: [imageToBase64, getMetaData, cropImage, rotateImage, resizeImage, compressImage],
  triggers: [],
});
