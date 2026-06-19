import { Command } from "commander";
import { findQadams, publishQadamFromFolder } from '../utils/qadam-utils';
import chalk from "chalk";
import { join } from "path";

async function syncQadams(
  params:
  {apiUrl: string,
  apiKey: string,
  qadams: string[] | null,
  failOnError: boolean,}
) {
  const qadamsDirectory = join(process.cwd(), 'packages', 'qadams', 'custom')
  const qadamFolders = await findQadams(qadamsDirectory, params.qadams);
    for (const qadamFolder of qadamFolders) {
      await publishQadamFromFolder({
        qadamFolder,
       ...params
      });
    }
}

export const syncQadamCommand = new Command('sync')
    .description('Find new qadam versions and sync them with the database')
    .requiredOption('-h, --apiUrl <url>', 'API URL ex: https://flow.aiqadam.org/api')
    .option('-p, --qadams <qadams...>', 'Specify one or more qadam names to sync. ' +
      'If not provided, all custom qadams in the directory will be synced.')
    .option('-f, --fail-on-error', 'Exit the process if an error occurs while syncing a qadam', false)
    .action(async (options) => {
        const apiKey = process.env.AP_API_KEY;
        const qadams = options.qadams ? [...new Set<string>(options.qadams)] : null;
        const failOnError = options.failOnError;
        if (!apiKey) {
            console.error(chalk.red('AP_API_KEY environment variable is required'));
            process.exit(1);
        }
        await syncQadams({
          apiUrl: options.apiUrl.replace(/\/$/, ''),
          apiKey,
          qadams,
          failOnError
        });
    });
