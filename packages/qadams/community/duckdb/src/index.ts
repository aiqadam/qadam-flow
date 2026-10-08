import { createQadam, QadamAuth, QadamCategory } from '@aiqadam/qadams-framework';

import { createAndQueryDB } from './lib/actions/create-and-query-db';

export const duckdb = createQadam({
  displayName: 'DuckDB',
  auth: QadamAuth.None(),
  minimumSupportedRelease: '0.0.0',
  logoUrl: '/assets/qadams/duckdb.png',
  description: 'Run SQL queries on an in-memory DuckDB database.',
  categories: [QadamCategory.DEVELOPER_TOOLS],
  authors: ['danielpoonwj'],
  actions: [createAndQueryDB],
  triggers: [],
});
