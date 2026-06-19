import { writeFile } from 'node:fs/promises';
import chalk from 'chalk';
import { Command } from 'commander';
import { buildPackage, findQadam, findQadams } from '../utils/qadam-utils';
import { makeFolderRecursive, readPackageJson } from '../utils/files';
import { join } from 'node:path';
import { exec } from '../utils/exec';
import { qadamTranslation } from '@aiqadam/qadams-framework';
import { MAX_KEY_LENGTH_FOR_CORWDIN } from '@aiqadam/shared';

const findQadamInModule = async (qadamOutputFile: string) => {
    const module = await import(qadamOutputFile);
    const exports = Object.values(module);
    for (const e of exports) {
      if (e !== null && e !== undefined && (e as { constructor: { name: string } }).constructor.name === 'Qadam') {
          return e
      }
      }

      throw new Error(`Qadam not found in module, please check the qadam output file ${qadamOutputFile}`);
}

const installDependencies = async (qadamFolder: string) => {
    console.log(chalk.blue(`Installing dependencies ${qadamFolder}`))
    await exec(`bun install`, {cwd: qadamFolder,})
    console.log(chalk.green(`Dependencies installed ${qadamFolder}`))
}


function getPropertyValue(object: Record<string, unknown>, path: string): unknown {
  const parsedKeys = path.split('.');
  if (parsedKeys[0] === '*') {
    return Object.values(object).map(item => getPropertyValue(item as Record<string, unknown>, parsedKeys.slice(1).join('.'))).filter(Boolean).flat()
  }
  const nextObject = object[parsedKeys[0]] as Record<string, unknown>;
  if (nextObject && parsedKeys.length > 1) {
    return getPropertyValue(nextObject, parsedKeys.slice(1).join('.'));
  }
  return nextObject;
}

const generateTranslationFileFromQadam = (qadam: Record<string, unknown>) => { const translation: Record<string, string> = {}
  try {
    qadamTranslation.pathsToValuesToTranslate.forEach(path => {
      const value = getPropertyValue(qadam, path)
      if (value) {
        if (typeof value === 'string') {
          translation[value.slice(0, MAX_KEY_LENGTH_FOR_CORWDIN)] = value
        }
        else if (Array.isArray(value)) {
          value.forEach(item => {
            translation[item.slice(0, MAX_KEY_LENGTH_FOR_CORWDIN)] = item
          })
        }
      }
    })
  }
  catch (err) {
    console.error(`error generating translation file for qadam ${qadam.name}:`, err)
  }

  return translation
}



const generateTranslationFile = async (qadamName: string) => {
  const qadamRoot = await findQadam(qadamName)
  if (!qadamRoot) {
    console.error(chalk.red('❌'), `Qadam '${qadamName}' not found`);
    return;
  }
  const packageJson = await readPackageJson(qadamRoot)
  await buildPackage(packageJson.name)
  try{
    await installDependencies(qadamRoot)
    const qadamFromModule = await findQadamInModule(qadamRoot);
    const i18n = generateTranslationFileFromQadam({actions: (qadamFromModule as { _actions: unknown })._actions, triggers: (qadamFromModule as { _triggers: unknown })._triggers, description: (qadamFromModule as { description: unknown }).description, displayName: (qadamFromModule as { displayName: unknown }).displayName, auth: (qadamFromModule as { auth: unknown }).auth});
    const i18nFolder = join(qadamRoot, 'src', 'i18n')
    await makeFolderRecursive(i18nFolder);
    await writeFile(join(i18nFolder, 'translation.json'), JSON.stringify(i18n, null, 2));
    console.log(chalk.yellow('✨'), `Translation file for qadam created in ${i18nFolder}`);
  } catch (error) {
    console.error(chalk.red('❌'), `Error generating translation file for qadam ${qadamName}, make sure you built the qadam`,error);
  }
};


export const generateTranslationFileForQadamCommand = new Command('generate-translation-file')
  .description('Generate i18n for a qadam')
  .argument('<qadamName>', 'The name of the qadam to generate i18n for')
  .action(async (qadamName: string) => {
    await generateTranslationFile(qadamName);
  });
  export const generateTranslationFileForAllQadamsCommand = new Command('generate-translation-file-for-all-qadams')
  .description('Generate i18n for all qadams')
  .requiredOption('--shard-index <shardIndex>', 'Zero-based shard index to process', (value) => parseInt(value, 10))
  .requiredOption('--shard-total <shardTotal>', 'Total number of shards', (value) => parseInt(value, 10))
  .action(async ({shardIndex, shardTotal}: { shardIndex: number; shardTotal: number }) => {
    const qadamsDirectory = join(process.cwd(), 'packages', 'qadams', 'community')
    const qadams = (await findQadams(qadamsDirectory)).map(qadam => qadam.split('/').pop());
    let totalTime = 0
    let indexAcrossAllQadams = 0
    for (const qadam of qadams) {
      if (!qadam) continue
      if ((indexAcrossAllQadams % shardTotal) !== shardIndex) {
        indexAcrossAllQadams++
        continue
      }
      const time= performance.now()
      await generateTranslationFile(qadam);
      console.log(chalk.yellow('✨'), `Translation file for qadam ${qadam} created in ${(performance.now() - time)/1000}s`)
      totalTime += (performance.now() - time)/1000
      indexAcrossAllQadams++
    }
    console.log(chalk.yellow('✨'), `Total time taken to generate translation files for selected qadams: ${totalTime}s`)
  });
