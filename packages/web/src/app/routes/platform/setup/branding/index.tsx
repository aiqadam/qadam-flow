import { t } from 'i18next';

import { CenteredPage } from '@/app/components/centered-page';
import LockedFeatureGuard from '@/app/components/locked-feature-guard';
import { AppearanceSection } from '@/app/routes/platform/setup/branding/appearance-section';
import { platformHooks } from '@/hooks/platform-hooks';

export const BrandingPage = () => {
  const { platform } = platformHooks.useCurrentPlatform();
  return (
    <LockedFeatureGuard
      locked={!platform.plan.customAppearanceEnabled}
      lockTitle={t('Branding')}
      lockDescription={t(
        'Give your users an experience that looks like you by customizing the color, logo and more',
      )}
    >
      <CenteredPage
        title={t('Branding')}
        description={t('Configure the appearance for your platform.')}
      >
        <AppearanceSection />
      </CenteredPage>
    </LockedFeatureGuard>
  );
};
