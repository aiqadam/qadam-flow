import { KnowledgeBaseSourceType } from '@aiqadam/shared';
import { t } from 'i18next';
import { FileText, Plus, Table2 } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { useKnowledgeBaseToolDialogStore } from '../stores/knowledge-base-tools';

type AddKnowledgeBaseDropdownProps = {
  disabled?: boolean;
  /** File sources are embedded at run time; table sources are not, so only files are gated. */
  fileSourcesDisabled?: boolean;
};

export const AddKnowledgeBaseDropdown = ({
  disabled,
  fileSourcesDisabled,
}: AddKnowledgeBaseDropdownProps) => {
  const [open, setOpen] = useState(false);
  const { setShowAddKbDialog } = useKnowledgeBaseToolDialogStore();

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger disabled={disabled} asChild>
        <Button variant="outline" size="sm">
          <Plus className="size-4 mr-2" />
          {t('Add')}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start">
        <DropdownMenuItem
          disabled={fileSourcesDisabled}
          onSelect={() =>
            setShowAddKbDialog(true, undefined, KnowledgeBaseSourceType.FILE)
          }
        >
          <FileText className="size-3.5 me-2" />
          <span>{t('Upload File')}</span>
        </DropdownMenuItem>

        <DropdownMenuItem
          onSelect={() =>
            setShowAddKbDialog(true, undefined, KnowledgeBaseSourceType.TABLE)
          }
        >
          <Table2 className="size-3.5 me-2" />
          <span>{t('Connect Table')}</span>
        </DropdownMenuItem>

        {fileSourcesDisabled && (
          <p className="max-w-60 px-2 py-1.5 text-xs text-muted-foreground">
            {t(
              'File sources require a provider that supports embeddings, such as OpenAI or Google.',
            )}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
