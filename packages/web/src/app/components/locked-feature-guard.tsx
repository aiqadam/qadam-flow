import { t } from 'i18next';
import { Clock } from 'lucide-react';
import React from 'react';

import { Badge } from '@/components/ui/badge';

type LockedFeatureGuardProps = {
  children: React.ReactNode;
  locked: boolean;
  lockTitle: string;
  lockDescription?: string;
};

export const LockedFeatureGuard = ({
  children,
  locked,
  lockTitle,
  lockDescription,
}: LockedFeatureGuardProps) => {
  if (!locked) {
    return children;
  }

  return (
    <div className="flex w-full flex-col items-center justify-center gap-2">
      <div className="pt-8 text-center flex flex-col gap-2 justify-center items-center">
        <Badge variant="outline" className="gap-1.5 text-muted-foreground mb-2">
          <Clock className="size-3" />
          {t('Soon')}
        </Badge>
        <h1 className="text-3xl font-bold">{lockTitle}</h1>
        <div className="text-center w-[485px] my-4 flex flex-col gap-2 justify-center items-center">
          <p className="text-md leading-relaxed text-muted-foreground">
            {lockDescription ??
              t('This feature is coming soon to Qadam Flow — no paywalls.')}
          </p>
        </div>
      </div>
    </div>
  );
};

export default LockedFeatureGuard;
