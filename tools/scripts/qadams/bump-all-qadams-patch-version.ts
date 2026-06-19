import fs from 'fs';
import path from 'path';

interface PackageJson {
  name: string;
  version: string;
  [key: string]: any;
}

interface UpdateResult {
  success: boolean;
  oldVersion?: string;
  newVersion?: string;
  error?: string;
}

// Function to bump patch version
function bumpPatchVersion(version: string): string {
  const parts = version.split('.');
  if (parts.length >= 3) {
    const patch = parseInt(parts[2]) + 1;
    return `${parts[0]}.${parts[1]}.${patch}`;
  }
  return version;
}

// Function to update package.json
function updatePackageJson(packageJsonPath: string): UpdateResult {
  try {
    const content = fs.readFileSync(packageJsonPath, 'utf8');
    const packageJson: PackageJson = JSON.parse(content);
    
    if (packageJson.version) {
      const oldVersion = packageJson.version;
      const newVersion = bumpPatchVersion(oldVersion);
      
      console.log(`Bumping ${path.basename(path.dirname(packageJsonPath))}: ${oldVersion} -> ${newVersion}`);
      
      packageJson.version = newVersion;
      
      // Write back to file with proper formatting
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








function getQadamDirectories(qadamsDir: string): string[] {
  return fs.readdirSync(qadamsDir)
    .filter(item => {
      const fullPath = path.join(qadamsDir, item);
      return fs.statSync(fullPath).isDirectory();
    });
}

function main(): void {
  console.log('Finding qadams with translation changes compared to main...');

  const qadamsDir = 'packages/qadams/community';

  const qadamDirs = getQadamDirectories(qadamsDir);

  console.log(`Checking ${qadamDirs.length} qadams for changes...`);

  let successCount = 0;
  let errorCount = 0;

  for (const qadam of qadamDirs) {
    const packageJsonPath = path.join(qadamsDir, qadam, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const result = updatePackageJson(packageJsonPath);
      if (result.success) {
        successCount++;
      } else {
        errorCount++;
      }
    } else {
      console.warn(`Skipping ${qadam} (no package.json)`);
    }
  }

  console.log(`\nSummary:`);
  console.log(`  Successfully updated: ${successCount} qadams`);
  console.log(`  Errors: ${errorCount} qadams`);
}

// Run the script
main();