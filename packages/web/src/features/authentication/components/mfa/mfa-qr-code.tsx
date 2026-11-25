import { t } from 'i18next';
import { QRCodeSVG } from 'qrcode.react';

import { CopyToClipboardInput } from '@/components/custom/clipboard/copy-to-clipboard';

type MfaQrCodeProps = {
  otpauthUrl: string;
  secret: string;
};

export const MfaQrCode = ({ otpauthUrl, secret }: MfaQrCodeProps) => {
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        {t('Scan this QR code with your authenticator app.')}
      </p>
      <div className="flex justify-start rounded-md border border-border bg-background p-4">
        <QRCodeSVG value={otpauthUrl} size={160} />
      </div>
      <div className="grid gap-1.5">
        <p className="text-sm text-muted-foreground">
          {t("Can't scan the code? Enter this key manually:")}
        </p>
        <CopyToClipboardInput textToCopy={secret} useInput={true} />
      </div>
    </div>
  );
};
