import assert from 'node:assert';
import { QadamMetadata } from '../../../packages/qadams/framework/src';
import { StatusCodes } from 'http-status-codes';
import { HttpHeader } from '../../../packages/qadams/common/src';
import { AP_CLOUD_API_BASE, findNewQadams, qadamMetadataExists } from '../utils/qadam-script-utils';
import { chunk } from '../../../packages/shared/src/lib/core/common/utils/utils';
assert(process.env['AP_CLOUD_API_KEY'], 'API Key is not defined');

const { AP_CLOUD_API_KEY } = process.env;

const insertQadamMetadata = async (
  qadamMetadata: QadamMetadata
): Promise<void> => {
  const body = JSON.stringify(qadamMetadata);

  const headers = {
    ['api-key']: AP_CLOUD_API_KEY,
    [HttpHeader.CONTENT_TYPE]: 'application/json'
  };

  const cloudResponse = await fetch(`${AP_CLOUD_API_BASE}/admin/qadams`, {
    method: 'POST',
    headers,
    body
  });

  if (cloudResponse.status !== StatusCodes.OK && cloudResponse.status !== StatusCodes.CONFLICT) {
    throw new Error(await cloudResponse.text());
  }
};



const insertMetadataIfNotExist = async (qadamMetadata: QadamMetadata) => {
  console.info(
    `insertMetadataIfNotExist, name: ${qadamMetadata.name}, version: ${qadamMetadata.version}`
  );

  const metadataAlreadyExist = await qadamMetadataExists(
    qadamMetadata.name,
    qadamMetadata.version
  );

  if (metadataAlreadyExist) {
    console.info(`insertMetadataIfNotExist, qadam metadata already inserted`);
    return;
  }

  await insertQadamMetadata(qadamMetadata);
};

const insertMetadata = async (qadamsMetadata: QadamMetadata[]) => {
  const batches = chunk(qadamsMetadata, 30)
  for (const batch of batches) {
    await Promise.all(batch.map(insertMetadataIfNotExist))
    await new Promise(resolve => setTimeout(resolve, 5000))
  }
};

const main = async () => {
  console.log('update qadams metadata: started')

  const qadamsMetadata = await findNewQadams()
  await insertMetadata(qadamsMetadata)

  console.log('update qadams metadata: completed')
  process.exit()
}

main()
