import { createQadam } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { oracleDbAuth } from './lib/common/auth';
import { insertRowAction } from './lib/actions/insert-row';
import { insertRowsAction } from './lib/actions/insert-rows';
import { runCustomSqlAction } from './lib/actions/run-custom-sql';
import { updateRowAction } from './lib/actions/update-row';
import { deleteRowAction } from './lib/actions/delete-row';
import { findRowAction } from './lib/actions/find-row';
import { newRowTrigger } from './lib/triggers/new-row';

export const oracleDatabase = createQadam({
  displayName: 'Oracle Database',
  description: 'Enterprise-grade relational database',
  auth: oracleDbAuth,
  minimumSupportedRelease: '0.36.1',
  logoUrl: '/assets/qadams/oracle-database.png',
  categories: [QadamCategory.DEVELOPER_TOOLS],
  authors: ['Prabhukiran161', 'onyedikachi-david', 'sanket-a11y'],
  actions: [
    insertRowAction,
    insertRowsAction,
    runCustomSqlAction,
    updateRowAction,
    deleteRowAction,
    findRowAction,
  ],
  triggers: [newRowTrigger],
});