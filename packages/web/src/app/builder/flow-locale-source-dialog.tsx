import { FlowOperationType, LOCALE_SOURCE_MAX_LENGTH } from '@aiqadam/shared';
import { t } from 'i18next';
import { useState } from 'react';

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
  // Once a save fails, `flowUpdatesQueue` (promise-queue.ts) is permanently halted for the rest of
  // this builder session — every later operation (including a retried Save here) is silently
  // dropped, never resolving or rejecting, so re-enabling Save would just spin forever a second
  // time. There is no in-app recovery from a halted queue, so this state is sticky for the
  // dialog's lifetime rather than something a retry can clear.
  const [hasSaveFailed, setHasSaveFailed] = useState(false);

  const isTooLong = localeSource.trim().length > LOCALE_SOURCE_MAX_LENGTH;

  const handleSave = () => {
    if (isTooLong || hasSaveFailed) {
      return;
    }
    setIsSaving(true);
    applyOperation(
      {
        type: FlowOperationType.UPDATE_LOCALE_SOURCE,
        request: { localeSource: localeSource.trim() || null },
      },
      () => {
        setIsSaving(false);
        onOpenChange(false);
      },
      () => {
        setIsSaving(false);
        setHasSaveFailed(true);
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
      {hasSaveFailed && (
        <Alert variant="destructive">
          <AlertDescription>
            {t('This change was not saved. Refresh the page to try again.')}
          </AlertDescription>
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
          disabled={isTooLong || hasSaveFailed}
          onClick={handleSave}
        >
          {t('Save')}
        </Button>
      </DialogFooter>
    </div>
  );
}

export { FlowLocaleSourceDialog };
