import { QadamAuth, Property } from '@aiqadam/qadams-framework';
import { BlobServiceClient } from '@azure/storage-blob';

export const azureBlobStorageAuth = QadamAuth.CustomAuth({
  displayName: 'Azure Blob Storage Auth',
  description:
    'Authenticate with Azure Blob Storage using Account Name and Account Key',
  props: {
    connectionString: Property.ShortText({
      displayName: 'Connection String',
      description:
        "You can obtain it from 'Security + networking -> Access Keys' menu.",
      required: true,
    }),
  },
  required: true,
  validate: async ({ auth }) => {
    try {
      const blobServiceClient = BlobServiceClient.fromConnectionString(
        auth.connectionString
      );
      await blobServiceClient.getAccountInfo();

      return {
        valid: true,
      };
    } catch {
      return {
        valid: false,
        error: 'Invalid Connection String',
      };
    }
  },
});
