import { Command } from "commander";
import { publishQadamFromFolder, findQadam, assertQadamExists } from '../utils/qadam-utils';
import chalk from "chalk";
import inquirer from 'inquirer';
import * as dotenv from 'dotenv';

dotenv.config({path: 'packages/server/api/.env'});

async function publishQadam(
    {apiUrl, apiKey, qadamName, failOnError}:
    {apiUrl: string,
    apiKey: string,
    qadamName: string,
    failOnError: boolean,}
) {
    const qadamFolder = await findQadam(qadamName);
    assertQadamExists(qadamFolder)
    await publishQadamFromFolder({
        qadamFolder: qadamFolder!,
        apiUrl,
        apiKey,
        failOnError
    });
}

function assertNullOrUndefinedOrEmpty(value: unknown, message: string) {
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
        console.error(chalk.red(message));
        process.exit(1);
    }
}

export const publishQadamCommand = new Command('publish')
    .description('Publish qadams to the platform')
    .option('-f, --fail-on-error', 'Exit the process if an error occurs while syncing a qadam', false)
    .action(async (command) => {
        const questions = [
            {
                type: 'input',
                name: 'name',
                message: 'Enter the qadam folder name',
                placeholder: 'google-drive',
            },
            {
                type: 'input',
                name: 'apiUrl',
                message: 'Enter the API URL',
                placeholder: 'https://flow.aiqadam.org/api',
            },
            {
                type: 'list',
                name: 'apiKeySource',
                message: 'Select the API Key source',
                choices: ['Env Variable (AP_API_KEY)', 'Manually'],
                default: 'Env Variable (AP_API_KEY)'
            }
        ]

        const answers = await inquirer.prompt(questions);
        if (answers.apiKeySource === 'Manually') {
            const apiKeyAnswers = await inquirer.prompt([{
                type: 'input',
                name: 'apiKey',
                message: 'Enter the API Key',
            }]);
            answers.apiKey = apiKeyAnswers.apiKey;
        }
        const apiKey = answers.apiKeySource === 'Env Variable (AP_API_KEY)' ? process.env.AP_API_KEY : answers.apiKey;
        assertNullOrUndefinedOrEmpty(answers.name, 'Qadam name is required');
        assertNullOrUndefinedOrEmpty(answers.apiUrl, 'API URL is required');
        assertNullOrUndefinedOrEmpty(apiKey, 'API Key is required');
        const apiUrlWithoutTrailSlash = answers.apiUrl.replace(/\/$/, '');
        const { failOnError } = command;

        await publishQadam({
            apiUrl: apiUrlWithoutTrailSlash,
            apiKey,
            qadamName: answers.name,
            failOnError
        });
    });
