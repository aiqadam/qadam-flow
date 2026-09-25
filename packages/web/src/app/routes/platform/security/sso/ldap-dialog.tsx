import {
  DEFAULT_LDAP_SESSION_TTL_SECONDS,
  formErrors,
  LdapTestRequest,
  LdapTestResponse,
  LdapTestStage,
  LdapTlsMode,
  PlatformLdapConfig,
  PlatformWithoutSensitiveData,
  UpsertLdapConfigRequest,
} from '@aiqadam/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { t } from 'i18next';
import { CheckCircle2, TriangleAlert, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ldapConfigMutations } from '@/features/platform-admin';
import { apiErrorUtils } from '@/lib/api-error-utils';
import { authenticationSession } from '@/lib/authentication-session';

const SUBJECT_ATTRIBUTE_OPTIONS = ['objectGUID', 'entryUUID'] as const;

// Any of these five requires the bind password to be re-entered on save — the server treats them
// as re-authenticating the bind account against the directory, not a cosmetic edit.
const FIELDS_REQUIRING_BIND_PASSWORD_CONFIRMATION = [
  'url',
  'bindDn',
  'tlsVerify',
  'tlsMode',
  'caCertificate',
] as const;

const SESSION_TTL_OPTIONS = [
  3600, 14400, 28800, 43200, 86400, 259200, 604800,
] as const;

export const ConfigureLdapDialog = ({
  platform,
  config,
}: {
  platform: PlatformWithoutSensitiveData;
  config: PlatformLdapConfig | null;
}) => {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="basic" onClick={() => setOpen(true)}>
          {config ? t('Edit') : t('Configure')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        {open && (
          <LdapConfigForm
            key={open ? 'open' : 'closed'}
            platform={platform}
            config={config}
            onClose={() => setOpen(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
};

const LdapConfigForm = ({
  platform,
  config,
  onClose,
}: {
  platform: PlatformWithoutSensitiveData;
  config: PlatformLdapConfig | null;
  onClose: () => void;
}) => {
  const isEditMode = config !== null;
  const isOwner = platform.ownerId === authenticationSession.getCurrentUserId();
  // While linking is on, the server rejects ANY change from a non-owner admin with 403 — not just
  // a change to the switch itself — because a directory admin can already take over a matching
  // local account, and the platform's own admins are exactly the accounts that protects. So the
  // whole form (not only the switch) goes read-only for a non-owner once linking is already on.
  const formLockedForNonOwner =
    !isOwner && (config?.config.linkExistingByEmail ?? false);
  const [clearCaCertificate, setClearCaCertificate] = useState(false);

  const form = useForm<LdapFormValues>({
    resolver: zodResolver(UpsertLdapConfigRequest),
    defaultValues: buildDefaultValues(config),
    mode: 'onChange',
  });

  const tlsMode = form.watch('tlsMode');
  const bindPasswordConfirmationRequired =
    isEditMode &&
    (clearCaCertificate ||
      FIELDS_REQUIRING_BIND_PASSWORD_CONFIRMATION.some(
        (name) => form.formState.dirtyFields[name],
      ));

  const { mutate: save, isPending } = ldapConfigMutations.useUpsertLdapConfig({
    onSuccess: onClose,
    onError: (error) => {
      form.setError('root.serverError', {
        type: 'manual',
        message: apiErrorUtils.extractServerMessage({
          error,
          fallback: t("Couldn't save the LDAP configuration"),
        }),
      });
    },
  });

  const { mutate: remove, isPending: isDeleting } =
    ldapConfigMutations.useDeleteLdapConfig({ onSuccess: onClose });

  const fieldsDisabled = isPending || formLockedForNonOwner;

  const handleSubmit = (values: LdapFormValues) => {
    if (formLockedForNonOwner) {
      return;
    }
    form.clearErrors('root.serverError');
    const bindPassword = (values.bindPassword ?? '').trim();
    if (
      (!isEditMode || bindPasswordConfirmationRequired) &&
      bindPassword.length === 0
    ) {
      form.setError('bindPassword', {
        type: 'manual',
        message: t(formErrors.required),
      });
      return;
    }
    const request: UpsertLdapConfigRequest = {
      ...values,
      bindPassword: bindPassword.length > 0 ? bindPassword : undefined,
      caCertificate: clearCaCertificate
        ? null
        : values.caCertificate && values.caCertificate.trim().length > 0
        ? values.caCertificate
        : undefined,
    };
    save(request);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {isEditMode
            ? t('Edit LDAP / Active Directory')
            : t('Configure LDAP / Active Directory')}
        </DialogTitle>
      </DialogHeader>
      {formLockedForNonOwner && (
        <Alert variant="warning">
          <TriangleAlert className="size-4" />
          <AlertDescription>
            {t(
              'Link existing accounts by email is on, so only the platform owner can change this configuration. Ask the owner to make changes, or to turn linking off first.',
            )}
          </AlertDescription>
        </Alert>
      )}
      <Form {...form}>
        <form
          className="grid space-y-4"
          onSubmit={form.handleSubmit(handleSubmit)}
        >
          <ScrollArea viewPortClassName="max-h-[calc(70vh)] p-px">
            <div className="space-y-4">
              <FormField
                name="url"
                render={({ field }) => (
                  <FormItem className="grid space-y-2">
                    <FormLabel htmlFor="ldapUrl">
                      {t('Directory URL')}
                    </FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        id="ldapUrl"
                        placeholder={
                          tlsMode === LdapTlsMode.LDAPS
                            ? 'ldaps://dc.acme.com:636'
                            : 'ldap://dc.acme.com:389'
                        }
                        disabled={fieldsDisabled}
                      />
                    </FormControl>
                    <FormDescription>
                      {t(
                        'A plaintext connection is not supported — the scheme must match the TLS mode below.',
                      )}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                name="tlsMode"
                render={({ field }) => (
                  <FormItem className="grid space-y-2">
                    <FormLabel>{t('TLS mode')}</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      disabled={fieldsDisabled}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value={LdapTlsMode.LDAPS}>
                          {t('LDAPS (implicit TLS)')}
                        </SelectItem>
                        <SelectItem value={LdapTlsMode.STARTTLS}>
                          {t('StartTLS')}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                name="tlsVerify"
                render={({ field }) => (
                  <FormItem className="grid space-y-2">
                    <div className="flex items-center justify-between">
                      <FormLabel htmlFor="tlsVerify">
                        {t('Verify certificate')}
                      </FormLabel>
                      <FormControl>
                        <Switch
                          id="tlsVerify"
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          disabled={fieldsDisabled}
                        />
                      </FormControl>
                    </div>
                    {!field.value && (
                      <Alert variant="warning">
                        <TriangleAlert className="size-4" />
                        <AlertDescription>
                          {t(
                            'The directory certificate will not be verified. Traffic is still encrypted, but this allows a network attacker to impersonate the directory. Only disable this for testing.',
                          )}
                        </AlertDescription>
                      </Alert>
                    )}
                  </FormItem>
                )}
              />

              <FormField
                name="caCertificate"
                render={({ field }) => (
                  <FormItem className="grid space-y-2">
                    <div className="flex items-center justify-between">
                      <FormLabel htmlFor="caCertificate">
                        {t('CA certificate (PEM)')}
                      </FormLabel>
                      {isEditMode &&
                        config?.hasCaCertificate &&
                        !clearCaCertificate && (
                          <Button
                            type="button"
                            variant="basic"
                            size="sm"
                            className="text-destructive"
                            disabled={fieldsDisabled}
                            onClick={() => {
                              setClearCaCertificate(true);
                              field.onChange('');
                            }}
                          >
                            {t('Remove')}
                          </Button>
                        )}
                    </div>
                    <FormControl>
                      <Textarea
                        name={field.name}
                        onBlur={field.onBlur}
                        ref={field.ref}
                        value={field.value ?? ''}
                        id="caCertificate"
                        minRows={4}
                        maxRows={10}
                        className="font-mono text-xs"
                        placeholder="-----BEGIN CERTIFICATE-----"
                        disabled={fieldsDisabled || clearCaCertificate}
                        onChange={(e) => {
                          setClearCaCertificate(false);
                          field.onChange(e);
                        }}
                      />
                    </FormControl>
                    <FormDescription>
                      {clearCaCertificate
                        ? t(
                            'The stored certificate will be removed when you save — the system trust store will be used instead.',
                          )
                        : isEditMode && config?.hasCaCertificate
                        ? t(
                            'A certificate is stored. Leave empty to keep it, or paste a new one to replace it.',
                          )
                        : t(
                            'Optional. Needed only for a private certificate authority — leave empty to use the system trust store.',
                          )}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Separator />

              <FormField
                name="bindDn"
                render={({ field }) => (
                  <FormItem className="grid space-y-2">
                    <FormLabel htmlFor="bindDn">
                      {t('Bind DN (service account)')}
                    </FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        id="bindDn"
                        placeholder="cn=svc-qadam-flow,dc=acme,dc=com"
                        disabled={fieldsDisabled}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                name="bindPassword"
                render={({ field }) => (
                  <FormItem className="grid space-y-2">
                    <FormLabel htmlFor="bindPassword">
                      {t('Bind password')}
                    </FormLabel>
                    <FormControl>
                      <Input
                        name={field.name}
                        onBlur={field.onBlur}
                        ref={field.ref}
                        value={field.value ?? ''}
                        onChange={field.onChange}
                        id="bindPassword"
                        type="password"
                        placeholder={
                          isEditMode && config?.hasBindPassword
                            ? t('Stored — leave empty to keep')
                            : ''
                        }
                        disabled={fieldsDisabled}
                      />
                    </FormControl>
                    {bindPasswordConfirmationRequired && (
                      <FormDescription>
                        {t(
                          'Re-enter the bind password to confirm this change — it touches the connection to the directory.',
                        )}
                      </FormDescription>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                name="baseDn"
                render={({ field }) => (
                  <FormItem className="grid space-y-2">
                    <FormLabel htmlFor="baseDn">{t('Base DN')}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        id="baseDn"
                        placeholder="dc=acme,dc=com"
                        disabled={fieldsDisabled}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                name="userFilter"
                render={({ field }) => (
                  <FormItem className="grid space-y-2">
                    <FormLabel htmlFor="userFilter">
                      {t('User filter')}
                    </FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        id="userFilter"
                        placeholder="(uid={username})"
                        disabled={fieldsDisabled}
                      />
                    </FormControl>
                    <FormDescription>
                      {t(
                        'Must contain the placeholder {username} exactly once — it is replaced with the escaped username at sign-in time.',
                      )}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Separator />
              <p className="text-sm font-medium">{t('Attribute mapping')}</p>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  name="attributeMap.subject"
                  render={({ field }) => (
                    <FormItem className="grid space-y-2">
                      <FormLabel htmlFor="attributeMapSubject">
                        {t('Subject attribute')}
                      </FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                        disabled={fieldsDisabled}
                      >
                        <FormControl>
                          <SelectTrigger id="attributeMapSubject">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {SUBJECT_ATTRIBUTE_OPTIONS.map((attribute) => (
                            <SelectItem key={attribute} value={attribute}>
                              {attribute}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  name="attributeMap.email"
                  render={({ field }) => (
                    <FormItem className="grid space-y-2">
                      <FormLabel htmlFor="attributeMapEmail">
                        {t('Email attribute')}
                      </FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          id="attributeMapEmail"
                          placeholder="mail"
                          disabled={fieldsDisabled}
                        />
                      </FormControl>
                      <FormDescription>
                        {t(
                          'Must not be writable by directory users themselves (e.g. a self-writable mail in OpenLDAP) — otherwise a user could take over another account by changing their own email to match it.',
                        )}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  name="attributeMap.firstName"
                  render={({ field }) => (
                    <FormItem className="grid space-y-2">
                      <FormLabel htmlFor="attributeMapFirstName">
                        {t('First name attribute')}
                      </FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          id="attributeMapFirstName"
                          placeholder="givenName"
                          disabled={fieldsDisabled}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  name="attributeMap.lastName"
                  render={({ field }) => (
                    <FormItem className="grid space-y-2">
                      <FormLabel htmlFor="attributeMapLastName">
                        {t('Last name attribute')}
                      </FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          id="attributeMapLastName"
                          placeholder="sn"
                          disabled={fieldsDisabled}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <Separator />

              <FormField
                name="jitProvisioning"
                render={({ field }) => (
                  <FormItem className="grid space-y-2">
                    <div className="flex items-center justify-between">
                      <FormLabel htmlFor="jitProvisioning">
                        {t('Provision accounts on first sign-in')}
                      </FormLabel>
                      <FormControl>
                        <Switch
                          id="jitProvisioning"
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          disabled={fieldsDisabled}
                        />
                      </FormControl>
                    </div>
                    <FormDescription>
                      {t(
                        'Automatically creates a Qadam Flow account the first time a directory user signs in. Turn off to only allow directory sign-in for accounts that already exist.',
                      )}
                    </FormDescription>
                  </FormItem>
                )}
              />

              <FormField
                name="linkExistingByEmail"
                render={({ field }) => (
                  <FormItem className="grid space-y-2">
                    <div className="flex items-center justify-between">
                      <FormLabel htmlFor="linkExistingByEmail">
                        {t('Link existing accounts by email')}
                      </FormLabel>
                      <FormControl>
                        <Switch
                          id="linkExistingByEmail"
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          disabled={isPending || !isOwner}
                        />
                      </FormControl>
                    </div>
                    <FormDescription>
                      {t(
                        'Enabling this lets the directory administrator take over any local account that matches a directory email address. Only enable this if you trust the directory administrator. The platform owner and platform admins are never linked this way.',
                      )}
                    </FormDescription>
                    {!isOwner && (
                      <FormDescription>
                        {t('Only the platform owner can change this setting.')}
                      </FormDescription>
                    )}
                    {field.value && (
                      <Alert variant="warning">
                        <TriangleAlert className="size-4" />
                        <AlertDescription>
                          {t(
                            'Anyone who controls a directory account with a matching email can sign in as the existing local user.',
                          )}
                        </AlertDescription>
                      </Alert>
                    )}
                  </FormItem>
                )}
              />

              <FormField
                name="sessionTtlSeconds"
                render={({ field }) => (
                  <FormItem className="grid space-y-2">
                    <FormLabel>{t('Session length')}</FormLabel>
                    <Select
                      value={String(field.value)}
                      onValueChange={(value) => field.onChange(Number(value))}
                      disabled={fieldsDisabled}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {SESSION_TTL_OPTIONS.map((seconds) => (
                          <SelectItem key={seconds} value={String(seconds)}>
                            {formatSessionTtl(seconds)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      {t(
                        'How long a directory sign-in stays valid before the user has to sign in again. Every sign-in re-checks the directory.',
                      )}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                name="enabled"
                render={({ field }) => (
                  <FormItem className="grid space-y-2">
                    <div className="flex items-center justify-between">
                      <FormLabel htmlFor="enabled">
                        {t('Enable LDAP sign-in')}
                      </FormLabel>
                      <FormControl>
                        <Switch
                          id="enabled"
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          disabled={fieldsDisabled}
                        />
                      </FormControl>
                    </div>
                  </FormItem>
                )}
              />

              {isEditMode && (
                <>
                  <Separator />
                  <TestConnectionPanel />
                </>
              )}

              {form.formState.errors.root?.serverError && (
                <FormMessage>
                  {form.formState.errors.root.serverError.message}
                </FormMessage>
              )}
            </div>
          </ScrollArea>

          <DialogFooter>
            {isEditMode && (
              <Button
                type="button"
                variant="basic"
                className="text-destructive mr-auto"
                loading={isDeleting}
                disabled={fieldsDisabled}
                onClick={() => remove()}
              >
                {t('Delete')}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={isPending}
              onClick={onClose}
            >
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={isPending} disabled={fieldsDisabled}>
              {t('Save')}
            </Button>
          </DialogFooter>
        </form>
      </Form>
    </>
  );
};

const TestConnectionPanel = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const {
    mutate: test,
    isPending,
    data: result,
  } = ldapConfigMutations.useTestLdapConfig();

  const request: LdapTestRequest =
    username.trim().length > 0 && password.length > 0
      ? { username: username.trim(), password }
      : {};

  return (
    <div className="grid space-y-3 rounded-lg border p-4">
      <p className="text-sm font-medium">{t('Test connection')}</p>
      <p className="text-sm text-muted-foreground">
        {t(
          'Tests the saved configuration. Save your changes first if you just edited the fields above.',
        )}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Input
          placeholder={t('Test username (optional)')}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={isPending}
        />
        <Input
          type="password"
          placeholder={t('Test password (optional)')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={isPending}
        />
      </div>
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={isPending}
          onClick={() => test(request)}
        >
          {t('Test connection')}
        </Button>
      </div>
      {result && <TestConnectionResult result={result} />}
    </div>
  );
};

const TestConnectionResult = ({ result }: { result: LdapTestResponse }) => (
  <Alert variant={result.success ? 'success' : 'destructive'}>
    {result.success ? (
      <CheckCircle2 className="size-4" />
    ) : (
      <XCircle className="size-4" />
    )}
    <AlertDescription className="flex flex-col gap-1">
      <span>{result.message}</span>
      <span className="text-xs opacity-80">
        {t('Stage')}: {formatStage(result.stage)}
        {result.ldapResultCode !== undefined &&
          ` — ${t('LDAP result code')}: ${result.ldapResultCode}`}
      </span>
    </AlertDescription>
  </Alert>
);

function formatStage(stage: LdapTestStage): string {
  switch (stage) {
    case LdapTestStage.ALLOW_LIST:
      return t('Host allow-list check');
    case LdapTestStage.CONNECT:
      return t('Connect');
    case LdapTestStage.SERVICE_BIND:
      return t('Service account bind');
    case LdapTestStage.SEARCH:
      return t('User search');
    case LdapTestStage.USER_BIND:
      return t('User bind');
    case LdapTestStage.SUCCESS:
      return t('Success');
    default:
      return stage;
  }
}

function formatSessionTtl(seconds: number): string {
  if (seconds < 86400) {
    return t('{hours, plural, =1 {1 hour} other {# hours}}', {
      hours: seconds / 3600,
    });
  }
  return t('{days, plural, =1 {1 day} other {# days}}', {
    days: seconds / 86400,
  });
}

function buildDefaultValues(config: PlatformLdapConfig | null): LdapFormValues {
  return {
    url: config?.config.url ?? '',
    tlsMode: config?.config.tlsMode ?? LdapTlsMode.LDAPS,
    baseDn: config?.config.baseDn ?? '',
    bindDn: config?.config.bindDn ?? '',
    userFilter: config?.config.userFilter ?? '(uid={username})',
    attributeMap: config?.config.attributeMap ?? {
      subject: 'objectGUID',
      email: 'mail',
      firstName: 'givenName',
      lastName: 'sn',
    },
    tlsVerify: config?.config.tlsVerify ?? true,
    jitProvisioning: config?.config.jitProvisioning ?? true,
    linkExistingByEmail: config?.config.linkExistingByEmail ?? false,
    sessionTtlSeconds:
      config?.config.sessionTtlSeconds ?? DEFAULT_LDAP_SESSION_TTL_SECONDS,
    enabled: config?.config.enabled ?? false,
    // Never prefilled with the real secret (the server never returns it) — `undefined` here,
    // not `''`, because the shared schema's `.min(1)` rejects an empty string but allows the
    // field to be entirely absent; an empty string would fail live validation on every render.
    bindPassword: undefined,
    caCertificate: undefined,
  };
}

type LdapFormValues = UpsertLdapConfigRequest;
