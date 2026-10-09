/* eslint-disable no-console */
import path from 'node:path'
import { parseArgs } from 'node:util'
import { isNil, tryCatch } from '@aiqadam/shared'
import { qadamVersionCatalogueWriter } from '../app/qadams/catalogue/qadam-version-catalogue-writer'

// The release pipeline's half of the qadam version catalogue (ADR-0003, #778). Two modes:
//
//   append-qadam-version-catalogue.js --archive <dir> --catalogue <dir>
//       Appends every version in `<archive>/archive-index.json` (#804's `--pack` output) to the
//       catalogue in `<catalogue>` (a checkout of the published `catalog/v1/`), creating it when the
//       directory is empty. All or nothing: any problem writes nothing and exits 1.
//
//   append-qadam-version-catalogue.js --verify --catalogue <dir>
//       Checks the catalogue: every entry parses, every metadata file matches its integrity.
//
// Prints one JSON line with the result. Exit codes: 0 done, 1 refused or invalid, 2 usage.
async function main(): Promise<void> {
    const { data: args, error: argsError } = await tryCatch(async () => parseArgs({
        options: {
            archive: { type: 'string' },
            catalogue: { type: 'string' },
            verify: { type: 'boolean', default: false },
        },
    }).values)
    if (argsError || isNil(args.catalogue) || (!args.verify && isNil(args.archive)) || (args.verify && !isNil(args.archive))) {
        console.error('usage: append-qadam-version-catalogue.js (--archive <dir> --catalogue <dir> | --verify --catalogue <dir>)')
        process.exit(2)
    }
    const catalogueDir = path.resolve(args.catalogue)
    const { data: result, error } = await tryCatch(async () => isNil(args.archive)
        ? qadamVersionCatalogueWriter.verify({ catalogueDir })
        : qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir: path.resolve(args.archive) }))
    if (error) {
        console.error(error)
        process.exit(1)
    }
    console.log(JSON.stringify(result))
    process.exit(result.status === 'appended' || result.status === 'ok' ? 0 : 1)
}

void main()
