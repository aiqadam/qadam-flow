import { PlatformWithoutSensitiveData } from '@aiqadam/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { t } from 'i18next';
import { Clock, ShieldCheck } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { platformApi } from '@/api/platforms-api';
import { CenteredPage } from '@/app/components/centered-page';
import {
  Item,
  ItemMedia,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from '@/components/custom/item';
import { Button } from '@/components/ui/button';
import { Form, FormField, FormItem, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { platformHooks } from '@/hooks/platform-hooks';
import { useIsMobile } from '@/hooks/use-mobile';
import { apiErrorUtils } from '@/lib/api-error-utils';

const MfaSettingsPage = () => {
  const { platform, refetch } = platformHooks.useCurrentPlatform();
  // PlatformLayout pins the SidebarProvider open, so on desktop the toggle would target a state
  // nothing renders from. Show it on mobile only, where the Sheet is the live sidebar (#716).
  const isMobile = useIsMobile();

  const { mutate: toggleEnforced, isPending: isTogglePending } = useMutation({
    mutationFn: async (mfaEnforced: boolean) => {
      await platformApi.update({ mfaEnforced }, platform.id);
      await refetch();
    },
    onSuccess: () => {
      toast.success(t('Two-factor authentication settings updated'), {
        duration: 3000,
      });
    },
    onError: (error) => {
      toast.error(
        apiErrorUtils.extractServerMessage({
          error,
          fallback: t("Couldn't update two-factor authentication settings"),
        }),
      );
    },
  });

  return (
    <CenteredPage
      title={t('Two-Factor Authentication')}
      description={t(
        'Require a second authentication factor for everyone who signs in to this platform.',
      )}
      showSidebarToggle={isMobile}
    >
      <div className="flex flex-col gap-4">
        <Item variant="outline">
          <ItemMedia variant="icon">
            <ShieldCheck />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{t('Require two-factor authentication')}</ItemTitle>
            <ItemDescription>
              {t(
                'Users without two-factor authentication must enrol the next time they sign in.',
              )}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Switch
              checked={platform.mfaEnforced}
              disabled={isTogglePending}
              onCheckedChange={(checked) => toggleEnforced(checked)}
            />
          </ItemActions>
        </Item>

        <GracePeriodItem platform={platform} refetch={refetch} />
      </div>
    </CenteredPage>
  );
};

const GracePeriodSchema = z.object({
  mfaEnforcementGracePeriodDays: z
    .string()
    .refine(
      (value) => /^\d+$/.test(value) && Number(value) <= 365,
      'invalidMfaGracePeriodDays',
    ),
});
type GracePeriodSchema = z.infer<typeof GracePeriodSchema>;

function GracePeriodItem({
  platform,
  refetch,
}: {
  platform: PlatformWithoutSensitiveData;
  refetch: () => Promise<void>;
}) {
  const form = useForm<GracePeriodSchema>({
    resolver: zodResolver(GracePeriodSchema),
    defaultValues: {
      mfaEnforcementGracePeriodDays: String(
        platform.mfaEnforcementGracePeriodDays,
      ),
    },
    mode: 'onChange',
  });

  const { mutate, isPending } = useMutation({
    mutationFn: async (days: number) => {
      await platformApi.update(
        { mfaEnforcementGracePeriodDays: days },
        platform.id,
      );
      await refetch();
    },
    onSuccess: () => {
      toast.success(t('Two-factor authentication settings updated'), {
        duration: 3000,
      });
    },
    onError: (error) => {
      toast.error(
        apiErrorUtils.extractServerMessage({
          error,
          fallback: t("Couldn't update two-factor authentication settings"),
        }),
      );
    },
  });

  return (
    <Item variant="outline">
      <ItemMedia variant="icon">
        <Clock />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{t('Grace period')}</ItemTitle>
        <ItemDescription>
          {t(
            'How many days existing users without two-factor authentication get before they must enrol. 0 means immediately.',
          )}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Form {...form}>
          <form
            className="flex items-start gap-2"
            onSubmit={form.handleSubmit((data) =>
              mutate(Number(data.mfaEnforcementGracePeriodDays)),
            )}
          >
            <FormField
              control={form.control}
              name="mfaEnforcementGracePeriodDays"
              render={({ field }) => (
                <FormItem className="w-20">
                  <Input
                    {...field}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={365}
                    className="rounded-sm"
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button
              type="submit"
              size="sm"
              loading={isPending}
              disabled={!form.formState.isValid}
            >
              {t('Save')}
            </Button>
          </form>
        </Form>
      </ItemActions>
    </Item>
  );
}

MfaSettingsPage.displayName = 'MfaSettingsPage';
export default MfaSettingsPage;
