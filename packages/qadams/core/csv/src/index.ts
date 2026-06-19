import { QadamAuth, createQadam } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { csvToJsonAction } from './lib/actions/convert-csv-to-json';
import { jsonToCsvAction } from './lib/actions/convert-json-to-csv';
import { excelToCsvAction } from './lib/actions/convert-excel-to-csv';

export const csv = createQadam({
  displayName: 'CSV',
  description: 'Manipulate CSV text',
  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/new-core/csv.svg',
  auth: QadamAuth.None(),
  categories: [QadamCategory.CORE],
  actions: [csvToJsonAction, jsonToCsvAction, excelToCsvAction],
  authors: ["kishanprmr", "MoShizzle", "khaledmashaly", "abuaboud", 'sanket-a11y'],
  triggers: [],
});
