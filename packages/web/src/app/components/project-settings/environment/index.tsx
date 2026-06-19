import { t } from 'i18next';

import LockedFeatureGuard from '@/app/components/locked-feature-guard';
import { platformHooks } from '@/hooks/platform-hooks';

import { ReleaseCard } from './release-card';

const EnvironmentSettings = () => {
  const { platform } = platformHooks.useCurrentPlatform();

  return (
    <LockedFeatureGuard
      locked={!platform.plan.environmentsEnabled}
      lockTitle={t('Environments')}
      lockDescription={t(
        'Deploy flows across development, staging and production environments with version control and team collaboration',
      )}
    >
      <div className="flex w-full flex-col items-start justify-center gap-4">
        <ReleaseCard />
      </div>
    </LockedFeatureGuard>
  );
};

export { EnvironmentSettings };
