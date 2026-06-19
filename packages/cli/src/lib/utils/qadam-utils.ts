import { readdir, stat } from 'node:fs/promises'
import * as path from 'path'
import { cwd } from 'node:process'
import { readPackageJson } from './files'
import { exec } from './exec'
import axios from 'axios'
import chalk from 'chalk'
import FormData from 'form-data';
import fs from 'fs';
import { prepareQadamDistForPublish } from './prepare-qadam-utils';

export const qadamsPath = () => path.join(cwd(), 'packages', 'qadams')
export const customQadamPath = () => path.join(qadamsPath(), 'custom')

export async function findQadams(inputPath?: string, qadams?: string[]): Promise<string[]> {
    const searchPath = inputPath ?? customQadamPath()
    const qadamFolders = await traverseFolder(searchPath)
    if (qadams) {
        return qadams.flatMap((qadam) => {
          const folder = qadamFolders.find((p) => {
              const normalizedPath = path.normalize(p);
              return normalizedPath.endsWith(path.sep + qadam);
          });
          if (!folder) {
              return [];
          }
          return [folder];
      });
    } else {
        return qadamFolders
    }
}

export async function findQadam(qadamName: string): Promise<string | null> {
    return (await findQadams(qadamsPath(), [qadamName]))[0] ?? null;
}

export async function buildQadam(qadamFolder: string): Promise<{ outputFolder: string, outputFile: string }> {
    const packageJson = await readPackageJson(qadamFolder);

    await buildPackage(packageJson.name);

    const compiledPath = `packages/${removeStartingSlashes(qadamFolder).split(path.sep + 'packages')[1]}/dist`;

    prepareQadamDistForPublish(qadamFolder);

    const { stdout } = await exec('npm pack --json', { cwd: compiledPath });
    const tarFileName = JSON.parse(stdout)[0].filename;
    return {
        outputFolder: compiledPath,
        outputFile: path.join(compiledPath, tarFileName)
    };
}

export async function buildPackage(packageName: string) {
    await exec(`npx turbo run build --filter=${packageName} --force`);
    return {
        outputFolder: `dist/packages/${packageName}`,
    }
}

export async function publishQadamFromFolder(
    {qadamFolder, apiUrl, apiKey, failOnError}:
  {qadamFolder: string,
  apiUrl: string,
  apiKey: string,
  failOnError: boolean,}
) {
    const packageJson = await readPackageJson(qadamFolder);

    await buildPackage(packageJson.name);

    const { outputFile } = await buildQadam(qadamFolder);
    const formData = new FormData();

    console.log(chalk.blue(`Uploading ${outputFile}`));
    formData.append('qadamArchive', fs.createReadStream(outputFile));
    formData.append('qadamName', packageJson.name);
    formData.append('qadamVersion', packageJson.version);
    formData.append('packageType', 'ARCHIVE');
    formData.append('scope', 'PLATFORM');

    try {
        await axios.post(`${apiUrl}/v1/qadams`, formData, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                ...formData.getHeaders()
            }
        });
        console.info(chalk.green(`Qadam '${packageJson.name}' published.`));
    } catch (error) {

        if (axios.isAxiosError(error)) {
            if (error.response?.status === 409) {
                console.info(chalk.yellow(`Qadam '${packageJson.name}' and '${packageJson.version}' already published.`));
            } else if (error.response && Math.floor(error.response.status / 100) !== 2) {
                console.info(chalk.red(`Error publishing qadam '${packageJson.name}',  ${error}` ));
                if (failOnError) {
                    console.info(chalk.yellow(`Terminating process due to publish failure for qadam '${packageJson.name}' (fail-on-error is enabled)`));
                    process.exit(1);
                }
            } else {
                console.error(chalk.red(`Unexpected error: ${error.message}`));
                if (failOnError) {
                    console.info(chalk.yellow(`Terminating process due to unexpected error for qadam '${packageJson.name}' (fail-on-error is enabled)`));
                    process.exit(1);
                }
            }
        } else {
            console.error(chalk.red(`Unexpected error: ${error.message}`));
            if (failOnError) {
              console.info(chalk.yellow(`Terminating process due to unexpected error for qadam '${packageJson.name}' (fail-on-error is enabled)`));
              process.exit(1);
            }
        }
    }
}
async function traverseFolder(folderPath: string): Promise<string[]> {
    const paths: string[] = []
    const directoryExists = await stat(folderPath).catch(() => null)

    if (directoryExists && directoryExists.isDirectory()) {
        const files = await readdir(folderPath)

        for (const file of files) {
            const filePath = path.join(folderPath, file)
            const fileStats = await stat(filePath)
            if (fileStats.isDirectory() && file !== 'node_modules' && file !== 'dist') {
                paths.push(...await traverseFolder(filePath))
            }
            else if (file === 'package.json') {
                paths.push(folderPath)
            }
        }
    }
    return paths
}

export function displayNameToKebabCase(displayName: string): string {
    return displayName.toLowerCase().replace(/\s+/g, '-');
}

export function displayNameToCamelCase(input: string): string {
    const words = input.split(' ');
    const camelCaseWords = words.map((word, index) => {
      if (index === 0) {
        return word.toLowerCase();
      } else {
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      }
    });
    return camelCaseWords.join('');
  }

export const assertQadamExists = async (qadamName: string | null) => {
    if (!qadamName) {
      console.error(chalk.red(`🚨 Qadam ${qadamName} not found`));
      process.exit(1);
    }
  };


  export const removeStartingSlashes = (str: string) => {
    return str.startsWith('/') ? str.slice(1) : str;
  }

