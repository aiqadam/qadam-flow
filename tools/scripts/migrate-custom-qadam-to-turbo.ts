#!/usr/bin/env node

/**
 * Migration script for custom qadams from Nx to Turbo.
 *
 * This script migrates a custom qadam (or all qadams in a directory) from the
 * old Nx-based build system to the new Turbo-based build system.
 *
 * Changes made:
 * 1. Updates package.json with build/lint scripts and workspace dependencies
 * 2. Updates tsconfig.lib.json with correct outDir and baseUrl/paths/rootDir
 * 3. Deletes project.json (Nx configuration)
 *
 * Usage:
 *   npx ts-node tools/scripts/migrate-custom-qadam-to-turbo.ts [qadam-path]
 *
 * If no path is provided, it scans packages/qadams/custom/ for all qadams.
 */

import * as fs from 'fs';
import * as path from 'path';

const CUSTOM_QADAMS_DIR = path.resolve(__dirname, '../../packages/qadams/custom');

function getRelativeRoot(qadamDir: string): string {
  const qadamsIndex = qadamDir.indexOf('/packages/qadams/');
  if (qadamsIndex === -1) {
    throw new Error(`Unexpected qadam directory structure: ${qadamDir}`);
  }
  const relative = path.relative(qadamDir, qadamDir.substring(0, qadamsIndex));
  return relative;
}

function migrateQadam(qadamDir: string): void {
  const qadamName = path.basename(qadamDir);
  const relativeRoot = getRelativeRoot(qadamDir);

  console.log(`\nMigrating qadam: ${qadamName}`);

  let changes = 0;

  const pkgPath = path.join(qadamDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    let pkgChanged = false;

    if (!pkg.scripts) {
      pkg.scripts = {};
    }

    if (pkg.scripts.build !== 'tsc -p tsconfig.lib.json && cp package.json dist/') {
      pkg.scripts.build = 'tsc -p tsconfig.lib.json && cp package.json dist/';
      pkgChanged = true;
    }

    if (pkg.scripts.lint !== "eslint 'src/**/*.ts'") {
      pkg.scripts.lint = "eslint 'src/**/*.ts'";
      pkgChanged = true;
    }

    if (pkg.main !== './src/index.js') {
      pkg.main = './src/index.js';
      pkgChanged = true;
    }

    if (pkg.types !== './src/index.d.ts') {
      pkg.types = './src/index.d.ts';
      pkgChanged = true;
    }

    const requiredDeps: Record<string, string> = {
      '@aiqadam/qadams-framework': 'workspace:*',
      '@aiqadam/shared': 'workspace:*',
      'tslib': '2.6.2',
    };

    if (!pkg.dependencies) {
      pkg.dependencies = {};
    }

    for (const [dep, version] of Object.entries(requiredDeps)) {
      if (!pkg.dependencies[dep]) {
        pkg.dependencies[dep] = version;
        pkgChanged = true;
      }
    }

    if (pkgChanged) {
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      console.log(`  ✓ Updated package.json`);
      changes++;
    } else {
      console.log(`  - package.json already up to date`);
    }
  } else {
    console.log(`  ✗ No package.json found — skipping`);
    return;
  }

  const tsconfigLibPath = path.join(qadamDir, 'tsconfig.lib.json');
  if (fs.existsSync(tsconfigLibPath)) {
    const tsconfig = JSON.parse(fs.readFileSync(tsconfigLibPath, 'utf-8'));
    let tsconfigChanged = false;

    if (!tsconfig.compilerOptions) {
      tsconfig.compilerOptions = {};
    }

    const expectedOutDir = './dist';
    if (tsconfig.compilerOptions.outDir !== expectedOutDir) {
      tsconfig.compilerOptions.outDir = expectedOutDir;
      tsconfigChanged = true;
    }

    if (tsconfig.compilerOptions.rootDir !== '.') {
      tsconfig.compilerOptions.rootDir = '.';
      tsconfigChanged = true;
    }
    if (tsconfig.compilerOptions.baseUrl !== '.') {
      tsconfig.compilerOptions.baseUrl = '.';
      tsconfigChanged = true;
    }

    if (JSON.stringify(tsconfig.compilerOptions.paths) !== '{}') {
      tsconfig.compilerOptions.paths = {};
      tsconfigChanged = true;
    }

    if (tsconfig.compilerOptions.declaration !== true) {
      tsconfig.compilerOptions.declaration = true;
      tsconfigChanged = true;
    }

    if (!tsconfig.compilerOptions.types || !tsconfig.compilerOptions.types.includes('node')) {
      tsconfig.compilerOptions.types = ['node'];
      tsconfigChanged = true;
    }

    if (tsconfigChanged) {
      fs.writeFileSync(tsconfigLibPath, JSON.stringify(tsconfig, null, 2) + '\n');
      console.log(`  ✓ Updated tsconfig.lib.json`);
      changes++;
    } else {
      console.log(`  - tsconfig.lib.json already up to date`);
    }
  } else {
    const tsconfig = {
      extends: './tsconfig.json',
      compilerOptions: {
        module: 'commonjs',
        rootDir: '.',
        baseUrl: '.',
        paths: {},
        outDir: './dist',
        declaration: true,
        types: ['node'],
      },
      exclude: ['jest.config.ts', 'src/**/*.spec.ts', 'src/**/*.test.ts'],
      include: ['src/**/*.ts'],
    };
    fs.writeFileSync(tsconfigLibPath, JSON.stringify(tsconfig, null, 2) + '\n');
    console.log(`  ✓ Created tsconfig.lib.json`);
    changes++;
  }

  const tsconfigPath = path.join(qadamDir, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) {
    const tsconfig = {
      extends: `${relativeRoot}/tsconfig.base.json`,
      files: [],
      include: [],
      references: [{ path: './tsconfig.lib.json' }],
      compilerOptions: {
        forceConsistentCasingInFileNames: true,
        strict: true,
        noImplicitReturns: true,
        noFallthroughCasesInSwitch: true,
      },
    };
    fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + '\n');
    console.log(`  ✓ Created tsconfig.json`);
    changes++;
  }

  const projectJsonPath = path.join(qadamDir, 'project.json');
  if (fs.existsSync(projectJsonPath)) {
    fs.unlinkSync(projectJsonPath);
    console.log(`  ✓ Deleted project.json (Nx config)`);
    changes++;
  }

  const workspaceJsonPath = path.join(qadamDir, 'workspace.json');
  if (fs.existsSync(workspaceJsonPath)) {
    fs.unlinkSync(workspaceJsonPath);
    console.log(`  ✓ Deleted workspace.json`);
    changes++;
  }

  if (changes === 0) {
    console.log(`  Already migrated — no changes needed`);
  } else {
    console.log(`  Done — ${changes} change(s) applied`);
  }
}

function findQadamDirs(baseDir: string): string[] {
  if (!fs.existsSync(baseDir)) {
    return [];
  }

  return fs.readdirSync(baseDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .filter(d => d.name !== 'node_modules' && d.name !== '.turbo' && d.name !== 'dist')
    .map(d => path.join(baseDir, d.name))
    .filter(dir => fs.existsSync(path.join(dir, 'package.json')));
}

const args = process.argv.slice(2);

if (args.length > 0) {
  const qadamPath = path.resolve(args[0]);
  if (!fs.existsSync(qadamPath)) {
    console.error(`Error: Path not found: ${qadamPath}`);
    process.exit(1);
  }
  migrateQadam(qadamPath);
} else {
  console.log(`Scanning ${CUSTOM_QADAMS_DIR} for qadams...`);
  const qadamDirs = findQadamDirs(CUSTOM_QADAMS_DIR);

  if (qadamDirs.length === 0) {
    console.log('No custom qadams found to migrate.');
    process.exit(0);
  }

  console.log(`Found ${qadamDirs.length} qadam(s) to check.\n`);

  for (const dir of qadamDirs) {
    migrateQadam(dir);
  }

  console.log('\nMigration complete.');
}
