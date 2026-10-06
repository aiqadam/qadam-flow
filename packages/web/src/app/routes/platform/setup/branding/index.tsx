import { t } from 'i18next';

import { CenteredPage } from '@/app/components/centered-page';
import LockedFeatureGuard from '@/app/components/locked-feature-guard';
import { AppearanceSection } from '@/app/routes/platform/setup/branding/appearance-section';
import { platformHooks } from '@/hooks/platform-hooks';
import { useIsMobile } from '@/hooks/use-mobile';

export const BrandingPage = () => {
  const { platform } = platformHooks.useCurrentPlatform();
  // PlatformLayout pins the SidebarProvider open, so on desktop the toggle would target a state
  // nothing renders from. Show it on mobile only, where the Sheet is the live sidebar (#716).
  const isMobile = useIsMobile();
  return (
    <LockedFeatureGuard
      locked={!platform.plan.customAppearanceEnabled}
      lockTitle={t('Branding')}
      lockDescription={t(
        'Give your users an experience that looks like you by customizing the color, logo and more',
      )}
      showSidebarToggle={isMobile}
    >
      <CenteredPage
        title={t('Branding')}
        description={t('Configure the appearance for your platform.')}
        showSidebarToggle={isMobile}
      >
        <AppearanceSection />
      </CenteredPage>
    </LockedFeatureGuard>
  );
};
