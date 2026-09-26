import {
  ErrorCode,
  MAX_TRANSLATION_IMPORT_BYTES,
  TranslationImportFormat,
  TranslationImportMode,
} from '@aiqadam/shared';
import { t } from 'i18next';
import { TriangleAlert, Upload } from 'lucide-react';
import { useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { translationsMutations } from '@/features/translations/hooks/translations-hooks';
import { api } from '@/lib/api';
import { authenticationSession } from '@/lib/authentication-session';

// Loose sanity bound for the raw file at selection time — the real cap is enforced at submit
// against the parsed-and-re-serialized payload, which is what the server actually measures.
const FILE_SIZE_SANITY_MULTIPLIER = 4;

const detectFormat = (
  data: Record<string, unknown>,
): TranslationImportFormat => {
  const hasNestedValue = Object.values(data).some(
    (value) => typeof value === 'object' && value !== null,
  );
  return hasNestedValue
    ? TranslationImportFormat.NESTED
    : TranslationImportFormat.FLAT;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isTranslationImportFormatOrAuto = (
  value: string,
): value is TranslationImportFormat | 'auto' =>
  value === 'auto' ||
  value === TranslationImportFormat.FLAT ||
  value === TranslationImportFormat.NESTED;

const isTranslationImportMode = (
  value: string,
): value is TranslationImportMode =>
  value === TranslationImportMode.MERGE ||
  value === TranslationImportMode.REPLACE;

const resolveImportErrorMessage = (error: unknown): string => {
  if (!api.isError(error)) {
    return t('Something went wrong, please try again later');
  }
  if (error.response?.status === api.httpStatus.TooManyRequests) {
    return t('Too many requests');
  }
  if (error.response?.status === api.httpStatus.Forbidden) {
    return t("You don't have permission to import translations.");
  }
  if (api.isApError(error, ErrorCode.VALIDATION)) {
    return t(
      'The server rejected this import — check the key format and size limits.',
    );
  }
  return t('Something went wrong, please try again later');
};

type ImportTranslationsDialogProps = {
  onImported: (result: { importedKeys: number }) => void;
  children: React.ReactNode;
};

function ImportTranslationsDialog({
  onImported,
  children,
}: ImportTranslationsDialogProps) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-w-lg">
        <ImportTranslationsForm
          key={open ? 'open' : 'closed'}
          onOpenChange={setOpen}
          onImported={onImported}
        />
      </DialogContent>
    </Dialog>
  );
}

type ImportTranslationsFormProps = {
  onOpenChange: (open: boolean) => void;
  onImported: (result: { importedKeys: number }) => void;
};

function ImportTranslationsForm({
  onOpenChange,
  onImported,
}: ImportTranslationsFormProps) {
  const [locale, setLocale] = useState('');
  const [rawText, setRawText] = useState('');
  const [formatOverride, setFormatOverride] = useState<
    TranslationImportFormat | 'auto'
  >('auto');
  const [mode, setMode] = useState<TranslationImportMode>(
    TranslationImportMode.MERGE,
  );
  const [errorMessage, setErrorMessage] = useState('');

  const { mutate: importTranslations, isPending } =
    translationsMutations.useImport({
      onSuccess: (result) => {
        onImported(result);
        onOpenChange(false);
      },
      onError: (error) => {
        setErrorMessage(resolveImportErrorMessage(error));
      },
    });

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    // A raw file's byte size doesn't line up with `MAX_TRANSLATION_IMPORT_BYTES`, which bounds the
    // re-serialized `data` field (checked below, at submit, against the actual parsed payload) —
    // a nicely-indented file can read larger on disk than its minified JSON, so this is a loose
    // sanity bound to reject only an obviously pathological file early, not the real cap.
    if (
      file.size >
      MAX_TRANSLATION_IMPORT_BYTES * FILE_SIZE_SANITY_MULTIPLIER
    ) {
      setErrorMessage(t('This file is too large to import.'));
      event.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setRawText(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  const handleSubmit = () => {
    setErrorMessage('');
    const projectId = authenticationSession.getProjectId();
    if (!projectId) return;
    if (!locale.trim()) {
      setErrorMessage(t('Pick a locale for this file first.'));
      return;
    }
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawText);
      if (!isPlainObject(parsed)) {
        setErrorMessage(t('This is not valid JSON.'));
        return;
      }
      data = parsed;
    } catch {
      setErrorMessage(t('This is not valid JSON.'));
      return;
    }
    if (
      new TextEncoder().encode(JSON.stringify(data)).length >
      MAX_TRANSLATION_IMPORT_BYTES
    ) {
      setErrorMessage(
        t(
          'This import is larger than the 1 MB limit — split it into smaller files.',
        ),
      );
      return;
    }
    const format =
      formatOverride === 'auto' ? detectFormat(data) : formatOverride;
    importTranslations({
      projectId,
      locale: locale.trim(),
      format,
      mode,
      data,
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{t('Import translations')}</DialogTitle>
        <DialogDescription>
          {t(
            'Drop or paste a locale JSON file — flat (dot-separated keys) or nested objects both work.',
          )}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-2">
        <Label htmlFor="import-locale">{t('Locale')}</Label>
        <Input
          id="import-locale"
          value={locale}
          onChange={(e) => setLocale(e.target.value)}
          placeholder="ru"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="import-file">{t('File')}</Label>
        <Input
          id="import-file"
          type="file"
          accept="application/json,.json"
          onChange={handleFileChange}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="import-json">{t('Or paste JSON')}</Label>
        <Textarea
          id="import-json"
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          rows={6}
          className="font-mono text-xs"
          placeholder='{"welcome.title": "Salom"}'
        />
      </div>
      <div className="flex gap-4">
        <div className="flex-1 flex flex-col gap-2">
          <Label>{t('Shape')}</Label>
          <Select
            value={formatOverride}
            onValueChange={(value) => {
              if (isTranslationImportFormatOrAuto(value)) {
                setFormatOverride(value);
              }
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t('Auto-detect')}</SelectItem>
              <SelectItem value={TranslationImportFormat.FLAT}>
                {t('Flat')}
              </SelectItem>
              <SelectItem value={TranslationImportFormat.NESTED}>
                {t('Nested')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex-1 flex flex-col gap-2">
          <Label>{t('Mode')}</Label>
          <Select
            value={mode}
            onValueChange={(value) => {
              if (isTranslationImportMode(value)) {
                setMode(value);
              }
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TranslationImportMode.MERGE}>
                {t('Merge')}
              </SelectItem>
              <SelectItem value={TranslationImportMode.REPLACE}>
                {t('Replace')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {mode === TranslationImportMode.REPLACE && (
        <Alert variant="warning">
          <TriangleAlert className="h-4 w-4" />
          <AlertDescription>
            {t(
              "Replace removes this locale's value from every key not present in the file. Other locales on those keys are untouched.",
            )}
          </AlertDescription>
        </Alert>
      )}
      {errorMessage && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <Button
          variant="outline"
          onClick={() => onOpenChange(false)}
          disabled={isPending}
        >
          {t('Cancel')}
        </Button>
        <Button onClick={handleSubmit} loading={isPending}>
          <Upload className="h-4 w-4 mr-2" />
          {t('Import')}
        </Button>
      </DialogFooter>
    </div>
  );
}

export { ImportTranslationsDialog };
