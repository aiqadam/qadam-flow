import { createQadam, QadamAuth } from "@aiqadam/qadams-framework";
import { createRecords } from "./lib/actions/create-records";
import { QadamCategory } from "@aiqadam/shared";
import { deleteRecord } from "./lib/actions/delete-record";
import { updateRecord } from "./lib/actions/update-record";
import { getRecord } from "./lib/actions/get-record";
import { findRecords } from "./lib/actions/find-records";
import { clearTable } from "./lib/actions/clear-table";
import { downloadTable } from "./lib/actions/download-table";
import { newRecordTrigger } from "./lib/triggers/new-record";
import { deletedRecordTrigger } from "./lib/triggers/deleted-record";
import { updatedRecordTrigger } from "./lib/triggers/updated-record";

export const tables = createQadam({
  displayName: 'Tables',
  logoUrl: '/assets/qadams/new-core/tables.svg',
  categories: [QadamCategory.CORE],
  minimumSupportedRelease: '0.80.0',
  authors: ['amrdb'],
  auth: QadamAuth.None(),
  actions: [createRecords, deleteRecord, updateRecord, getRecord, findRecords, clearTable, downloadTable],
  triggers: [newRecordTrigger, updatedRecordTrigger, deletedRecordTrigger],
});
