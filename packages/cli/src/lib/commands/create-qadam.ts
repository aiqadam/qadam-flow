import chalk from 'chalk';
import { Command } from 'commander';
import { mkdir, readdir, writeFile } from 'fs/promises';
import inquirer from 'inquirer';
import path from 'node:path';

const validateQadamName = async (qadamName: string) => {
  console.log(chalk.yellow('Validating qadam name....'));
  const qadamNamePattern = /^(?![._])[a-z0-9-]{1,214}$/;
  if (!qadamNamePattern.test(qadamName)) {
    console.log(
      chalk.red(
        `🚨 Invalid qadam name: ${qadamName}. Qadam names can only contain lowercase letters, numbers, and hyphens.`
      )
    );
    process.exit(1);
  }
};

const validatePackageName = async (packageName: string) => {
  console.log(chalk.yellow('Validating package name....'));
  const packageNamePattern = /^(?:@[a-zA-Z0-9-]+\/)?[a-zA-Z0-9-]+$/;
  if (!packageNamePattern.test(packageName)) {
    console.log(
      chalk.red(
        `🚨 Invalid package name: ${packageName}. Package names can only contain lowercase letters, numbers, and hyphens.`
      )
    );
    process.exit(1);
  }
};

const checkIfQadamExists = async (qadamName: string, qadamType: string) => {
  const qadamPath = path.resolve('packages', 'qadams', qadamType, qadamName);
  try {
    await readdir(qadamPath);
    console.log(chalk.red(`🚨 Qadam already exists at ${qadamPath}`));
    process.exit(1);
  } catch {
    // Directory does not exist, which is expected
  }
};

function capitalizeFirstLetter(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

const scaffoldQadam = async (
  qadamName: string,
  packageName: string,
  qadamType: string
) => {
  const baseDir = path.resolve('packages', 'qadams', qadamType, qadamName);
  const srcDir = path.join(baseDir, 'src');
  const libDir = path.join(srcDir, 'lib');
  const i18nDir = path.join(srcDir, 'i18n');

  await mkdir(libDir, { recursive: true });
  await mkdir(i18nDir, { recursive: true });

  const packageJson = {
    name: packageName,
    version: '0.0.1',
    type: 'commonjs',
    main: './dist/src/index.js',
    types: './dist/src/index.d.ts',
    dependencies: {
      '@aiqadam/qadams-common': 'workspace:*',
      '@aiqadam/qadams-framework': 'workspace:*',
      '@aiqadam/shared': 'workspace:*',
      tslib: '2.6.2',
    },
    scripts: {
      build: 'tsc -p tsconfig.lib.json && cp package.json dist/',
      lint: "eslint 'src/**/*.ts'",
    },
  };
  await writeFile(
    path.join(baseDir, 'package.json'),
    JSON.stringify(packageJson, null, 2)
  );

  const tsconfig = {
    extends: '../../../../tsconfig.base.json',
    compilerOptions: {
      module: 'commonjs',
      forceConsistentCasingInFileNames: true,
      strict: true,
      noImplicitOverride: true,
      noPropertyAccessFromIndexSignature: true,
      noImplicitReturns: true,
      noFallthroughCasesInSwitch: true,
    },
    files: [],
    include: [],
    references: [{ path: './tsconfig.lib.json' }],
  };
  await writeFile(
    path.join(baseDir, 'tsconfig.json'),
    JSON.stringify(tsconfig, null, 2)
  );

  const tsconfigLib = {
    extends: './tsconfig.json',
    compilerOptions: {
      rootDir: '.',
      baseUrl: '.',
      paths: {},
      outDir: './dist',
      declaration: true,
      declarationMap: true,
      types: ['node'],
    },
    include: ['src/**/*.ts'],
    exclude: ['jest.config.ts', 'src/**/*.spec.ts', 'src/**/*.test.ts'],
  };
  await writeFile(
    path.join(baseDir, 'tsconfig.lib.json'),
    JSON.stringify(tsconfigLib, null, 2)
  );

  const eslintConfig = {
    extends: ['../../../../.eslintrc.json'],
    ignorePatterns: ['!**/*'],
    overrides: [
      { files: ['*.ts', '*.tsx', '*.js', '*.jsx'], rules: {} },
      { files: ['*.ts', '*.tsx'], rules: {} },
      { files: ['*.js', '*.jsx'], rules: {} },
    ],
  };
  await writeFile(
    path.join(baseDir, '.eslintrc.json'),
    JSON.stringify(eslintConfig, null, 2)
  );

  const qadamNameCamelCase = qadamName
    .split('-')
    .map((s, i) => {
      if (i === 0) {
        return s;
      }
      return s[0].toUpperCase() + s.substring(1);
    })
    .join('');

  const indexTemplate = `import { createQadam, QadamAuth } from '@aiqadam/qadams-framework';

export const ${qadamNameCamelCase} = createQadam({
  displayName: '${capitalizeFirstLetter(qadamName)}',
  description: '',
  auth: QadamAuth.None(),
  minimumSupportedRelease: '0.36.1',
  logoUrl: '/assets/qadams/${qadamName}.png',
  authors: [],
  actions: [],
  triggers: [],
});
`;

  await writeFile(path.join(srcDir, 'index.ts'), indexTemplate);
};

export const createQadam = async (
  qadamName: string,
  packageName: string,
  qadamType: string
) => {
  await validateQadamName(qadamName);
  await validatePackageName(packageName);
  await checkIfQadamExists(qadamName, qadamType);
  await scaffoldQadam(qadamName, packageName, qadamType);
  console.log(chalk.green('✨  Done!'));
  console.log(
    chalk.yellow(
      `The qadam has been generated at: packages/qadams/${qadamType}/${qadamName}`
    )
  );
};

export const createQadamCommand = new Command('create')
  .description('Create a new qadam')
  .action(async () => {
    const questions = [
      {
        type: 'input',
        name: 'qadamName',
        message: 'Enter the qadam name:',
      },
      {
        type: 'input',
        name: 'packageName',
        message: 'Enter the package name:',
        default: (answers: Record<string, string>) =>
          `@aiqadam/qadam-${answers.qadamName}`,
        when: (answers: Record<string, string>) =>
          answers.qadamName !== undefined,
      },
      {
        type: 'list',
        name: 'qadamType',
        message: 'Select the qadam type:',
        choices: ['community', 'custom'],
        default: 'community',
      },
    ];

    const answers = await inquirer.prompt(questions);
    createQadam(answers.qadamName, answers.packageName, answers.qadamType);
  });
