import { UpsertLdapConfigRequest } from '@aiqadam/shared';
import { t } from 'i18next';
import { Clock, FolderKey, LockIcon, MailIcon, Earth } from 'lucide-react';
import { toast } from 'sonner';

import { CenteredPage } from '@/app/components/centered-page';
import { AllowedDomainDialog } from '@/app/routes/platform/security/sso/allowed-domain';
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
import { Switch } from '@/components/ui/switch';
import {
  ldapConfigMutations,
  ldapConfigQueries,
  ssoMutations,
} from '@/features/platform-admin';
import { platformHooks } from '@/hooks/platform-hooks';

import GoogleIcon from '../../../../../assets/img/custom/auth/google-icon.svg';

const SoonBadge = () => (
  <Badge variant="outline" className="gap-1.5 text-muted-foreground">
    <Clock className="size-3" />
    {t('Soon')}
  </Badge>
);

const SSOPage = () => {
  const { platform, refetch } = platformHooks.useCurrentPlatform();
  const { data: ldapConfig } = ldapConfigQueries.useLdapConfig();

  const emailAuthEnabled = platform.emailAuthEnabled;

  const { mutate: toggleEmailAuthentication, isPending: isEmailAuthPending } =
    ssoMutations.useUpdatePlatformSso({
      platformId: platform.id,
      refetch,
      onSuccess: () => {
        toast.success(t('Email authentication updated'), { duration: 3000 });
      },
    });

  const { mutate: toggleLdapEnabled, isPending: isLdapTogglePending } =
    ldapConfigMutations.useUpsertLdapConfig({
      onSuccess: () => {
        toast.success(t('LDAP configuration updated'), { duration: 3000 });
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
            {(platform?.allowedAuthDomains ?? []).length > 0 && (
              <div className="mt-1 gap-2 flex">
                {(platform?.allowedAuthDomains ?? []).map((text, index) => (
                  <Badge key={index} variant={'outline'}>
                    {text}
                  </Badge>
                ))}
              </div>
            )}
          </ItemContent>
          <ItemActions>
            <AllowedDomainDialog platform={platform} refetch={refetch} />
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
          </ItemContent>
          <ItemActions>
            {ldapConfig && (
              <Switch
                checked={ldapConfig.config.enabled}
                disabled={isLdapTogglePending}
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
            <Switch
              checked={emailAuthEnabled}
              onCheckedChange={() =>
                toggleEmailAuthentication({
                  emailAuthEnabled: !platform.emailAuthEnabled,
                })
              }
              disabled={isEmailAuthPending}
            />
          </ItemActions>
        </Item>
      </div>
    </CenteredPage>
  );
};

SSOPage.displayName = 'SSOPage';
export { SSOPage };
