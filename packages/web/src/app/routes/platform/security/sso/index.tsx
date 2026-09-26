import { UpsertLdapConfigRequest } from '@aiqadam/shared';
import { t } from 'i18next';
import { Clock, FolderKey, LockIcon, MailIcon, Earth } from 'lucide-react';
import { toast } from 'sonner';

import { CenteredPage } from '@/app/components/centered-page';
import { ldapConfigFormUtils } from '@/app/routes/platform/security/sso/ldap-config-form-helpers';
import { ConfigureLdapDialog } from '@/app/routes/platform/security/sso/ldap-dialog';
import {
  Item,
  ItemMedia,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from '@/components/custom/item';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  ldapConfigMutations,
  ldapConfigQueries,
} from '@/features/platform-admin';
import { platformHooks } from '@/hooks/platform-hooks';
import { apiErrorUtils } from '@/lib/api-error-utils';
import { authenticationSession } from '@/lib/authentication-session';

import GoogleIcon from '../../../../../assets/img/custom/auth/google-icon.svg';

const SoonBadge = () => (
  <Badge variant="outline" className="gap-1.5 text-muted-foreground">
    <Clock className="size-3" />
    {t('Soon')}
  </Badge>
);

const SSOPage = () => {
  const { platform } = platformHooks.useCurrentPlatform();
  const {
    data: ldapConfig,
    isLoading: isLdapConfigLoading,
    isError: isLdapConfigError,
  } = ldapConfigQueries.useLdapConfig();

  const isOwner = platform.ownerId === authenticationSession.getCurrentUserId();
  const ldapQuickToggleLockedForNonOwner =
    ldapConfigFormUtils.computeFormLockedForNonOwner({
      isOwner,
      linkExistingByEmail: ldapConfig?.config.linkExistingByEmail ?? false,
    });

  const { mutate: toggleLdapEnabled, isPending: isLdapTogglePending } =
    ldapConfigMutations.useUpsertLdapConfig({
      onSuccess: () => {
        toast.success(t('LDAP configuration updated'), { duration: 3000 });
      },
      onError: (error) => {
        toast.error(
          apiErrorUtils.extractServerMessage({
            error,
            fallback: t("Couldn't save the LDAP configuration"),
          }),
        );
      },
    });

  return (
    <CenteredPage
      title={t('Single Sign On')}
      description={t('Manage single sign on providers')}
    >
      <div className="flex flex-col gap-4">
        <Item variant="outline">
          <ItemMedia variant="icon">
            <Earth />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{t('Allowed Domains')}</ItemTitle>
            <ItemDescription>
              {t('Restrict authentication to specific email domains.')}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <SoonBadge />
          </ItemActions>
        </Item>

        <Item variant="outline">
          <ItemMedia variant="icon">
            <FolderKey />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{t('LDAP / Active Directory')}</ItemTitle>
            <ItemDescription>
              {t(
                'Let users sign in with their on-premise directory username and password.',
              )}
            </ItemDescription>
            {ldapConfig && !ldapConfig.config.tlsVerify && (
              <div className="mt-1">
                <Badge variant="destructive">
                  {t('Certificate verification disabled')}
                </Badge>
              </div>
            )}
            {isLdapConfigError && (
              <p className="mt-1 text-sm text-destructive">
                {t("Couldn't load the LDAP configuration")}
              </p>
            )}
          </ItemContent>
          <ItemActions>
            {isLdapConfigLoading ? (
              <Button size="sm" variant="basic" disabled>
                {t('Loading…')}
              </Button>
            ) : isLdapConfigError ? (
              <Button size="sm" variant="basic" disabled>
                {t('Configure')}
              </Button>
            ) : (
              <>
                {ldapConfig && (
                  <Switch
                    checked={ldapConfig.config.enabled}
                    disabled={
                      isLdapTogglePending || ldapQuickToggleLockedForNonOwner
                    }
                    onCheckedChange={(checked) => {
                      const request: UpsertLdapConfigRequest = {
                        ...ldapConfig.config,
                        enabled: checked,
                      };
                      toggleLdapEnabled(request);
                    }}
                  />
                )}
                <ConfigureLdapDialog
                  platform={platform}
                  config={ldapConfig ?? null}
                />
              </>
            )}
          </ItemActions>
        </Item>

        <Item variant="outline">
          <ItemMedia variant="icon">
            <img className="size-6" src={GoogleIcon} alt="icon" />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Google</ItemTitle>
            <ItemDescription>
              {t("Allow logins through google's single sign-on functionality.")}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <SoonBadge />
          </ItemActions>
        </Item>

        <Item variant="outline">
          <ItemMedia variant="icon">
            <LockIcon />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{t('SAML 2.0')}</ItemTitle>
            <ItemDescription>
              {t(
                "Allow logins through saml 2.0's single sign-on functionality.",
              )}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <SoonBadge />
          </ItemActions>
        </Item>

        <Item variant="outline">
          <ItemMedia variant="icon">
            <MailIcon />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{t('Allowed Email Login')}</ItemTitle>
            <ItemDescription>
              {t('Allow logins through email and password.')}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <SoonBadge />
          </ItemActions>
        </Item>
      </div>
    </CenteredPage>
  );
};

SSOPage.displayName = 'SSOPage';
export { SSOPage };
