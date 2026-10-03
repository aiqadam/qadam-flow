/// <reference types="vitest/globals" />

import jimp from 'jimp';
import { imageToBase64 } from '../src/lib/actions/image-to-base64.action';
import { cropImage } from '../src/lib/actions/crop-image.action';
import { rotateImage } from '../src/lib/actions/rotate-image.action';
import { resizeImage } from '../src/lib/actions/resize-Image.action';
import { compressImage } from '../src/lib/actions/compress-image.actions';
import { getMetaData } from '../src/lib/actions/get-metadata.action';
import { createMockActionContext, ApFile } from '@aiqadam/qadams-framework';

async function createTestImage(width = 10, height = 10): Promise<ApFile> {
  const image = new jimp(width, height, 0xff0000ff);
  const buffer = await image.getBufferAsync('image/png');
  return new ApFile('test.png', buffer, 'png');
}

describe('imageToBase64', () => {
  test('converts image to base64 data URI', async () => {
    const file = await createTestImage();
    const ctx = createMockActionContext({
      propsValue: { image: file, override_mime_type: undefined },
    });
    const result = await imageToBase64.run(ctx);
    expect(typeof result).toBe('string');
    expect((result as string).startsWith('data:')).toBe(true);
    expect((result as string)).toContain('base64,');
  });

  test('uses override MIME type', async () => {
    const file = await createTestImage();
    const ctx = createMockActionContext({
      propsValue: { image: file, override_mime_type: 'image/jpeg' },
    });
    const result = await imageToBase64.run(ctx);
    expect((result as string).startsWith('data:image/jpeg;base64,')).toBe(true);
  });
});

describe('cropImage', () => {
  test('crops image to specified dimensions', async () => {
    const file = await createTestImage(20, 20);
    const ctx = createMockActionContext({
      propsValue: {
        image: file,
        left: 0,
        top: 0,
        width: 10,
        height: 10,
        resultFileName: 'cropped',
      },
    });
    const result = await cropImage.run(ctx);
    expect(result).toBe('test-file-url');
  });
});

describe('rotateImage', () => {
  test('rotates image 90 degrees', async () => {
    const file = await createTestImage();
    const ctx = createMockActionContext({
      propsValue: {
        image: file,
        degree: 90,
        resultFileName: 'rotated',
      },
    });
    const result = await rotateImage.run(ctx);
    expect(result).toBe('test-file-url');
  });

});

describe('resizeImage', () => {
  test('resizes image to specified dimensions', async () => {
    const file = await createTestImage(20, 20);
    const ctx = createMockActionContext({
      propsValue: {
        image: file,
        width: 10,
        height: 10,
        aspectRatio: false,
        resultFileName: 'resized',
      },
    });
    const result = await resizeImage.run(ctx);
    expect(result).toBe('test-file-url');
  });

});

describe('compressImage', () => {
  test('compresses image as JPEG', async () => {
    const file = await createTestImage();
    const ctx = createMockActionContext({
      propsValue: {
        image: file,
        quality: 90,
        format: 'image/jpeg',
        resultFileName: 'compressed',
      },
    });
    const result = await compressImage.run(ctx);
    expect(result).toBe('test-file-url');
  });

});

function embedXmp(jpeg: Buffer, packet: string): Buffer {
  const header = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1');
  const payload = Buffer.concat([header, Buffer.from(packet, 'utf-8')]);
  const segment = Buffer.alloc(4);
  segment.writeUInt16BE(0xffe1, 0);
  segment.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), segment, payload, jpeg.subarray(2)]);
}

describe('getMetaData', () => {
  test('parses the XMP packet of an image', async () => {
    const jpeg = await new jimp(10, 10, 0xff0000ff).getBufferAsync('image/jpeg');
    const packet =
      '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="Qadam Test Suite"/>' +
      '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
    const file = new ApFile('xmp.jpg', embedXmp(jpeg, packet), 'jpg');
    const ctx = createMockActionContext({ propsValue: { image: file } });

    const tags: unknown = await getMetaData.run(ctx);

    expect(creatorToolDescription(tags)).toBe('Qadam Test Suite');
  });
});

function creatorToolDescription(tags: unknown): unknown {
  if (typeof tags !== 'object' || tags === null || !('CreatorTool' in tags)) {
    return undefined;
  }
  const tag: unknown = tags.CreatorTool;
  return typeof tag === 'object' && tag !== null && 'description' in tag ? tag.description : undefined;
}
