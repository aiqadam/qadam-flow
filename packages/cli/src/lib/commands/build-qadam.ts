import { Command } from "commander";
import { buildQadam, findQadam } from '../utils/qadam-utils';
import chalk from "chalk";
import inquirer from "inquirer";

async function buildQadamByName(qadamName: string) {
    const qadamFolder = await findQadam(qadamName);
    if (!qadamFolder) {
        console.error(chalk.red(`🚨 Qadam '${qadamName}' not found`));
        process.exit(1);
    }
    const { outputFolder } = await buildQadam(qadamFolder);
    console.info(chalk.green(`Qadam '${qadamName}' built and packed successfully at ${outputFolder}.`));
}

export const buildQadamCommand = new Command('build')
    .description('Build qadams without publishing')
    .argument('[name]', 'name of the qadam to build')
    .option('--name <qadamName>', 'name of the qadam to build')
    .action(async (positionalName, options) => {
        const qadamName = positionalName ?? options.name;
        const questions = [
            {
                type: 'input',
                name: 'name',
                message: 'Enter the qadam folder name',
                placeholder: 'google-drive',
                when() {
                    return !qadamName
                }
            },
        ];
        const answers = await inquirer.prompt(questions);
        await buildQadamByName(qadamName ?? answers.name);
    });
