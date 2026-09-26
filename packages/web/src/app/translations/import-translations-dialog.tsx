import {
  ErrorCode,
  TranslationImportFormat,
  TranslationImportMode,
} from '@aiqadam/shared';
import { t } from 'i18next';
import { TriangleAlert, Upload } from 'lucide-react';
import { useRef, useState } from 'react';

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
  const fileInputRef = useRef<HTMLInputElement>(null);
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
    translationsMutations.useImport((result) => {
      onImported(result);
      onOpenChange(false);
    });

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
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
      data = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      setErrorMessage(t('This is not valid JSON.'));
      return;
    }
    const format =
      formatOverride === 'auto' ? detectFormat(data) : formatOverride;
    importTranslations(
      { projectId, locale: locale.trim(), format, mode, data },
      {
        onError: (error) => {
          if (api.isApError(error, ErrorCode.VALIDATION)) {
            setErrorMessage(
              t(
                'The server rejected this import — check the key format and size limits.',
              ),
            );
            return;
          }
        },
      },
    );
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
          ref={fileInputRef}
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
            onValueChange={(value) =>
              setFormatOverride(value as TranslationImportFormat | 'auto')
            }
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
            onValueChange={(value) => setMode(value as TranslationImportMode)}
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
