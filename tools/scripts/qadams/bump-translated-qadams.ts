import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

interface PackageJson {
  name: string;
  version: string;
  [key: string]: unknown;
}

interface UpdateResult {
  success: boolean;
  oldVersion?: string;
  newVersion?: string;
  error?: string;
}

function bumpPatchVersion(version: string): string {
  const parts = version.split('.');
  if (parts.length >= 3) {
    const patch = parseInt(parts[2]) + 1;
    return `${parts[0]}.${parts[1]}.${patch}`;
  }
  return version;
}

function updatePackageJson(packageJsonPath: string): UpdateResult {
  try {
    const content = fs.readFileSync(packageJsonPath, 'utf8');
    const packageJson: PackageJson = JSON.parse(content);

    if (packageJson.version) {
      const oldVersion = packageJson.version;
      const newVersion = bumpPatchVersion(oldVersion);

      console.log(`Bumping ${path.basename(path.dirname(packageJsonPath))}: ${oldVersion} -> ${newVersion}`);

      packageJson.version = newVersion;

      fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');

      return { success: true, oldVersion, newVersion };
    }

    return { success: false, error: 'No version field found in package.json' };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Error updating ${packageJsonPath}:`, errorMessage);
    return { success: false, error: errorMessage };
  }
}

function hasChangesComparedToMain(qadamPath: string): boolean {
  try {
    execSync(`git diff --quiet origin/main -- ${qadamPath}`, { encoding: 'utf8' });
    return false;
  } catch (error) {
    if (error instanceof Error && 'status' in error && error.status === 1) {
      return true;
    }
    throw error;
  }
}

function hasI18nDirectory(qadamPath: string): boolean {
  const i18nPath = path.join(qadamPath, 'src', 'i18n');
  return fs.existsSync(i18nPath) && fs.statSync(i18nPath).isDirectory();
}

function hasTranslationChanges(qadamPath: string): boolean {
  try {
    const i18nChanges = execSync(`git diff --name-only origin/main -- ${qadamPath}/src/i18n`, { encoding: 'utf8' }).trim();
    return i18nChanges.length > 0;
  } catch (error) {
    if (error instanceof Error && 'status' in error && error.status === 1) {
      return true;
    }
    return false;
  }
}

function hasVersionBeenBumped(qadamPath: string): boolean {
  try {
    const packageJsonPath = path.join(qadamPath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      return false;
    }

    const content = fs.readFileSync(packageJsonPath, 'utf8');
    const packageJson: PackageJson = JSON.parse(content);
    const currentVersion = packageJson.version;

    if (!currentVersion) {
      return false;
    }

    const mainVersion = execSync(`git show origin/main:${packageJsonPath}`, { encoding: 'utf8' });
    const mainPackageJson: PackageJson = JSON.parse(mainVersion);
    const mainBranchVersion = mainPackageJson.version;

    return compareVersions(currentVersion, mainBranchVersion) > 0;
  } catch {
    return false;
  }
}

function compareVersions(version1: string, version2: string): number {
  const v1Parts = version1.split('.').map(Number);
  const v2Parts = version2.split('.').map(Number);

  for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
    const v1Part = v1Parts[i] || 0;
    const v2Part = v2Parts[i] || 0;

    if (v1Part > v2Part) return 1;
    if (v1Part < v2Part) return -1;
  }

  return 0;
}

function getQadamDirectories(qadamsDir: string): string[] {
  return fs.readdirSync(qadamsDir)
    .filter(item => {
      const fullPath = path.join(qadamsDir, item);
      return fs.statSync(fullPath).isDirectory();
    });
}

function main(): void {
  console.log('Finding qadams with translation changes compared to main...');

  const qadamsWithChanges: string[] = [];
  const qadamsDir = 'packages/qadams/community';

  const qadamDirs = getQadamDirectories(qadamsDir);

  console.log(`Checking ${qadamDirs.length} qadams for changes...`);

  for (const qadam of qadamDirs) {
    const qadamPath = path.join(qadamsDir, qadam);
    if (hasChangesComparedToMain(qadamPath)) {
      if (hasI18nDirectory(qadamPath)) {
        if (hasTranslationChanges(qadamPath)) {
          if (hasVersionBeenBumped(qadamPath)) {
            console.log(`  - ${qadam} - has translation changes but version already bumped`);
          } else {
            qadamsWithChanges.push(qadam);
            console.log(`  ✓ ${qadam} - has translation changes and needs version bump`);
          }
        } else {
          console.log(`  - ${qadam} - has changes but not translation-related`);
        }
      } else {
        console.log(`  - ${qadam} - has changes but no i18n directory`);
      }
    } else {
      console.log(`  - ${qadam} - no changes`);
    }
  }

  if (qadamsWithChanges.length === 0) {
    console.log('\nNo qadams with translation changes found.');
    return;
  }

  console.log(`\nFound ${qadamsWithChanges.length} qadams with translation changes:`);
  qadamsWithChanges.forEach(qadam => console.log(`  - ${qadam}`));

  console.log('\nBumping patch versions...');

  let successCount = 0;
  let errorCount = 0;

  for (const qadam of qadamsWithChanges) {
    const packageJsonPath = path.join(qadamsDir, qadam, 'package.json');

    if (fs.existsSync(packageJsonPath)) {
      const result = updatePackageJson(packageJsonPath);
      if (result.success) {
        successCount++;
      } else {
        errorCount++;
      }
    } else {
      console.error(`Package.json not found for ${qadam}`);
      errorCount++;
    }
  }

  console.log(`\nSummary:`);
  console.log(`  Successfully updated: ${successCount} qadams`);
  console.log(`  Errors: ${errorCount} qadams`);
}

main();
