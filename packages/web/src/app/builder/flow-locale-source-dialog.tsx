import { FlowOperationType } from '@aiqadam/shared';
import { t } from 'i18next';
import { useState } from 'react';

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

  const handleSave = () => {
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
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            {t('Cancel')}
          </Button>
        </DialogClose>
        <Button type="button" loading={isSaving} onClick={handleSave}>
          {t('Save')}
        </Button>
      </DialogFooter>
    </div>
  );
}

export { FlowLocaleSourceDialog };
