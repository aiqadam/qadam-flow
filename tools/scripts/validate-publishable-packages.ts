import { findAllQadamsDirectoryInSource } from './utils/qadam-script-utils';
import { packagePrePublishChecks } from './utils/package-pre-publish-checks';

async function processBatches<T, R>(items: T[], batchSize: number, processor: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    results.push(...await Promise.all(batch.map(processor)));
    if (i + batchSize < items.length) await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return results;
}

const main = async () => {
  const qadamsMetadata = await findAllQadamsDirectoryInSource()
  const sharedDeps = ['packages/qadams/framework', 'packages/qadams/common']

  const sharedResults = await Promise.all(sharedDeps.map(packagePrePublishChecks))
  const validationResults = await processBatches(
    qadamsMetadata.filter(p => !sharedDeps.includes(p)),
    10,
    packagePrePublishChecks
  )

  if (!sharedResults.every(p => p)) {
    validationResults.push(await packagePrePublishChecks('packages/shared'))
  }
}

main();
