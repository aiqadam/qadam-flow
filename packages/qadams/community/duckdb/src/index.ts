import { createQadam, QadamAuth } from '@aiqadam/qadams-framework';

import { createAndQueryDB } from './lib/actions/create-and-query-db';
import { QadamCategory } from '@aiqadam/shared';

export const duckdb = createQadam({
  displayName: 'DuckDB',
  auth: QadamAuth.None(),
  minimumSupportedRelease: '0.36.1',
  logoUrl: '/assets/qadams/duckdb.png',
  description: 'Run SQL queries on an in-memory DuckDB database.',
  categories: [QadamCategory.DEVELOPER_TOOLS],
  authors: ['danielpoonwj'],
  actions: [createAndQueryDB],
  triggers: [],
});
