import chalk from 'chalk';
import { Command } from 'commander';
import inquirer from 'inquirer';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkIfFileExists, makeFolderRecursive } from '../utils/files';
import {
    assertQadamExists,
  displayNameToCamelCase,
  displayNameToKebabCase, findQadam,
} from '../utils/qadam-utils';

function createTriggerTemplate(displayName: string, description: string, technique: string) {
    const camelCase = displayNameToCamelCase(displayName)
    let triggerTemplate = ''
    if (technique === 'polling') {
        triggerTemplate = `
import { createTrigger, TriggerStrategy, AppConnectionValueForAuthProperty  } from '@aiqadam/qadams-framework';
import { DedupeStrategy, Polling, pollingHelper } from '@aiqadam/qadams-common';
import dayjs from 'dayjs';

// replace auth with qadam auth variable
const polling: Polling<AppConnectionValueForAuthProperty<undefined>, Record<string, never> > = {
    strategy: DedupeStrategy.TIMEBASED,
    items: async ({ propsValue, lastFetchEpochMS }) => {
        // implement the logic to fetch the items
        const items = [ {id: 1, created_date: '2021-01-01T00:00:00Z'}, {id: 2, created_date: '2021-01-01T00:00:00Z'}];
        return items.map((item) => ({
            epochMilliSeconds: dayjs(item.created_date).valueOf(),
            data: item,
            }));
        }
}

export const ${camelCase} = createTrigger({
// auth: check https://flow.aiqadam.org/docs/developers/qadam-reference/authentication,
name: '${camelCase}',
displayName: '${displayName}',
description: '${description}',
props: {},
sampleData: {},
type: TriggerStrategy.POLLING,
async test(context) {
    return await pollingHelper.test(polling, context);
},
async onEnable(context) {
    const { store, auth, propsValue } = context;
    await pollingHelper.onEnable(polling, { store, auth, propsValue });
},

async onDisable(context) {
    const { store, auth, propsValue } = context;
    await pollingHelper.onDisable(polling, { store, auth, propsValue });
},

async run(context) {
    return await pollingHelper.poll(polling, context);
},
});`;
    }
    else {
        triggerTemplate = `
import { createTrigger, TriggerStrategy } from '@aiqadam/qadams-framework';
export const ${camelCase} = createTrigger({
    // auth: check https://flow.aiqadam.org/docs/developers/qadam-reference/authentication,
    name: '${camelCase}',
    displayName: '${displayName}',
    description: '${description}',
    props: {},
    sampleData: {},
    type: TriggerStrategy.WEBHOOK,
    async onEnable(context){
        // implement webhook creation logic
    },
    async onDisable(context){
        // implement webhook deletion logic
    },
    async run(context){
        return [context.payload.body]
    }
})`;

    }

    return triggerTemplate
}
const checkIfTriggerExists = async (triggerPath: string) => {
    if (await checkIfFileExists(triggerPath)) {
        console.log(chalk.red(`🚨 Trigger already exists at ${triggerPath}`));
        process.exit(1);
    }
}
const createTrigger = async (qadamName: string, displayTriggerName: string, triggerDescription: string, triggerTechnique: string) => {
    const triggerTemplate = createTriggerTemplate(displayTriggerName, triggerDescription, triggerTechnique)
    const triggerName = displayNameToKebabCase(displayTriggerName)
    const qadamFolder = await findQadam(qadamName);
    assertQadamExists(qadamFolder)
    console.log(chalk.blue(`Qadam path: ${qadamFolder}`))

    const triggersFolder = join(qadamFolder!, 'src', 'lib', 'triggers')
    const triggerPath = join(triggersFolder, `${triggerName}.ts`)
    await checkIfTriggerExists(triggerPath)

    await makeFolderRecursive(triggersFolder);
    await writeFile(triggerPath, triggerTemplate);
    console.log(chalk.yellow('✨'), `Trigger ${triggerPath} created`);
};


export const createTriggerCommand = new Command('create')
    .description('Create a new trigger')
    .action(async () => {
        const questions = [
            {
                type: 'input',
                name: 'qadamName',
                message: 'Enter the qadam folder name:',
                placeholder: 'google-drive',
            },
            {
                type: 'input',
                name: 'triggerName',
                message: 'Enter the trigger display name:',
            },
            {
                type: 'input',
                name: 'triggerDescription',
                message: 'Enter the trigger description:',
            },
            {
                type: 'list',
                name: 'triggerTechnique',
                message: 'Select the trigger technique:',
                choices: ['polling', 'webhook'],
                default: 'webhook',
            },
        ];

        const answers = await inquirer.prompt(questions);
        createTrigger(answers.qadamName, answers.triggerName, answers.triggerDescription, answers.triggerTechnique);
    });
