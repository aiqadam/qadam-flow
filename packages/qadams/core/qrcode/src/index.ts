
    import { createQadam, QadamAuth } from "@aiqadam/qadams-framework";
    import { QadamCategory } from '@aiqadam/shared';
    import { outputQrcodeAction } from './lib/actions/output-qrcode-action'
    
    export const qrcode = createQadam({
      displayName: 'QR Code',
      auth: QadamAuth.None(),
      minimumSupportedRelease: '0.30.0',
      logoUrl: "/assets/qadams/new-core/qrcode.svg",
      categories: [QadamCategory.CORE],
      authors: ['Meng-Yuan Huang'],
      actions: [
        outputQrcodeAction,
      ],
      triggers: [],
    });
    