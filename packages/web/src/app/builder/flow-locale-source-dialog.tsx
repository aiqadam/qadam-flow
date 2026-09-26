import { FlowOperationType, LOCALE_SOURCE_MAX_LENGTH } from '@aiqadam/shared';
import { t } from 'i18next';
import { useEffect, useRef, useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';

import { useBuilderStateContext } from './builder-hooks';
import { TextInputWithMentions } from './qadam-properties/text-input-with-mentions';

// `applyOperation` (flow-state.ts) exposes only an `onSuccess` callback — on a failed request it
// logs the error and halts the update queue, never calling back here at all, so `isSaving` would
// otherwise stay true forever with no way for this dialog to know the save failed. Without a
// dedicated error path to plug into, a bounded timeout is the least invasive way to guarantee the
// Save button becomes clickable again; it does not by itself mean the save failed — genuinely slow
// networks resolve normally via the `onSuccess` callback well before this fires, and it's cleared on
// unmount so it can't fire after the dialog has already closed and remounted fresh.
const SAVE_TIMEOUT_MS = 15_000;

type FlowLocaleSourceDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function FlowLocaleSourceDialog({
  open,
  onOpenChange,
}: FlowLocaleSourceDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <FlowLocaleSourceForm
          key={open ? 'open' : 'closed'}
          onOpenChange={onOpenChange}
        />
      </DialogContent>
    </Dialog>
  );
}

type FlowLocaleSourceFormProps = {
  onOpenChange: (open: boolean) => void;
};

function FlowLocaleSourceForm({ onOpenChange }: FlowLocaleSourceFormProps) {
  const initialLocaleSource = useBuilderStateContext(
    (state) => state.flowVersion.localeSource,
  );
  const applyOperation = useBuilderStateContext(
    (state) => state.applyOperation,
  );
  const [localeSource, setLocaleSource] = useState(initialLocaleSource ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  const isTooLong = localeSource.trim().length > LOCALE_SOURCE_MAX_LENGTH;

  const handleSave = () => {
    if (isTooLong) {
      return;
    }
    setIsSaving(true);
    saveTimeoutRef.current = setTimeout(() => {
      setIsSaving(false);
    }, SAVE_TIMEOUT_MS);
    applyOperation(
      {
        type: FlowOperationType.UPDATE_LOCALE_SOURCE,
        request: { localeSource: localeSource.trim() || null },
      },
      () => {
        if (saveTimeoutRef.current) {
          clearTimeout(saveTimeoutRef.current);
        }
        setIsSaving(false);
        onOpenChange(false);
      },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{t('Locale settings')}</DialogTitle>
        <DialogDescription>
          {t(
            "Pick which locale this flow resolves translation keys in for each run — a fixed tag (ru) or an expression such as a step's language field.",
          )}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-2">
        <Label>{t('Run locale')}</Label>
        <TextInputWithMentions
          initialValue={localeSource}
          onChange={setLocaleSource}
          placeholder={t('e.g. ru, or a step field holding the locale')}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          "Resolution order: a mention's own dynamic locale, then this run locale, then the project's default locale.",
        )}
      </p>
      {isTooLong && (
        <Alert variant="destructive">
          <AlertDescription>{t('localeSourceTooLong')}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            {t('Cancel')}
          </Button>
        </DialogClose>
        <Button
          type="button"
          loading={isSaving}
          disabled={isTooLong}
          onClick={handleSave}
        >
          {t('Save')}
        </Button>
      </DialogFooter>
    </div>
  );
}

export { FlowLocaleSourceDialog };
