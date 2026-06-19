import { Command } from 'commander';
import { createActionCommand } from './lib/commands/create-action';
import { createQadamCommand } from './lib/commands/create-qadam';
import { createTriggerCommand } from './lib/commands/create-trigger';
import { syncQadamCommand } from './lib/commands/sync-qadams';
import { publishQadamCommand } from './lib/commands/publish-qadam';
import { buildQadamCommand } from './lib/commands/build-qadam';
import { generateWorkerTokenCommand } from './lib/commands/generate-worker-token';
import { generateTranslationFileForAllQadamsCommand, generateTranslationFileForQadamCommand } from './lib/commands/generate-translation-file-for-qadam';

const qadamCommand = new Command('qadams')
  .description('Manage qadams');

qadamCommand.addCommand(createQadamCommand);
qadamCommand.addCommand(syncQadamCommand);
qadamCommand.addCommand(publishQadamCommand);
qadamCommand.addCommand(buildQadamCommand);
qadamCommand.addCommand(generateTranslationFileForQadamCommand);
qadamCommand.addCommand(generateTranslationFileForAllQadamsCommand);
const actionCommand = new Command('actions')
  .description('Manage actions');

actionCommand.addCommand(createActionCommand);

const triggerCommand = new Command('triggers')
  .description('Manage triggers')

triggerCommand.addCommand(createTriggerCommand)


const workerCommand = new Command('workers')
  .description('Manage workers')

workerCommand.addCommand(generateWorkerTokenCommand)

const program = new Command();

program.version('0.0.1').description('Qadam Flow CLI');

program.addCommand(qadamCommand);
program.addCommand(actionCommand);
program.addCommand(triggerCommand);
program.addCommand(workerCommand);
program.parse(process.argv);
