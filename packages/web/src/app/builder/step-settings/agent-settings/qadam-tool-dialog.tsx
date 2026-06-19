import { AgentTool, isNil, mcpToolNameUtils } from '@aiqadam/shared';
import { t } from 'i18next';
import { ChevronLeft } from 'lucide-react';
import { useMemo, useEffect } from 'react';
import { toast } from 'sonner';
import { useDebounce } from 'use-debounce';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  QadamActionsList,
  QadamsList,
  useQadamToolsDialogStore,
} from '@/features/agents';
import {
  stepsHooks,
  QadamStepMetadataWithSuggestions,
} from '@/features/qadams';

import { PredefinedInputsForm } from './predefined-inputs-form';

type AgentToolsDialogProps = {
  tools: AgentTool[];
  onToolsUpdate: (tools: AgentTool[]) => void;
};

const excludedPieces = [
  '@aiqadam/qadam-ai',
  '@aiqadam/qadam-mcp',
  '@aiqadam/qadam-openai',
  '@aiqadam/qadam-claude',
  '@aiqadam/qadam-google-gemini',
  '@aiqadam/qadam-grok-xai',
];

export function AgentPieceDialog({
  tools,
  onToolsUpdate,
}: AgentToolsDialogProps) {
  const {
    showAddQadamDialog,
    selectedPage,
    searchQuery,
    selectedAction,
    isQadamAuthSet,
    selectedQadam,
    editingQadamTool,
    createNewQadamTool,
    goBackToActionsList,
    handleQadamSelect,
    handleActionSelect,
    goBackToQadamsList,
    closeQadamDialog,
  } = useQadamToolsDialogStore();

  const [debouncedQuery] = useDebounce(searchQuery, 300);

  const { metadata, isLoading: isPiecesLoading } =
    stepsHooks.useAllStepsMetadata({
      searchQuery: debouncedQuery,
      type: 'action',
    });

  const qadamMetadata = useMemo(() => {
    return (
      metadata
        ?.filter(
          (m): m is QadamStepMetadataWithSuggestions =>
            'suggestedActions' in m && 'suggestedTriggers' in m,
        )
        .filter((piece) => !excludedPieces.includes(piece.qadamName)) ?? []
    );
  }, [metadata]);

  useEffect(() => {
    if (!showAddQadamDialog) return;
    if (!isNil(editingQadamTool) && qadamMetadata.length > 0) {
      const piece = qadamMetadata.find(
        (p) => p.qadamName === editingQadamTool.pieceMetadata.qadamName,
      );

      if (piece) {
        handleQadamSelect(piece);
        const action = piece.suggestedActions?.find((a) => {
          return (
            mcpToolNameUtils.createQadamToolName(piece.qadamName, a.name) ===
            editingQadamTool.toolName
          );
        });
        if (action) {
          handleActionSelect(action);
        }
      }
    }
  }, [showAddQadamDialog, editingQadamTool, qadamMetadata]);

  const authIsSetValue = isQadamAuthSet();

  const handleSave = () => {
    const newTool = createNewQadamTool();
    if (isNil(newTool)) return;

    if (!isNil(editingQadamTool)) {
      const updatedTools = tools.map((tool) =>
        tool.toolName === editingQadamTool.toolName ? newTool : tool,
      );
      onToolsUpdate(updatedTools);
      toast('Qadam tool updated');
    } else {
      onToolsUpdate([...tools, newTool]);
      toast('Qadam tool added');
    }

    closeQadamDialog();
  };

  const handleDialogClose = (open: boolean) => {
    if (!open) {
      closeQadamDialog();
    }
  };

  const renderDialogMainContent = () => {
    switch (selectedPage) {
      case 'qadams-list': {
        return (
          <QadamsList
            isPiecesLoading={isPiecesLoading}
            qadamMetadata={qadamMetadata}
          />
        );
      }
      case 'actions-list': {
        return <QadamActionsList tools={tools} />;
      }
      case 'action-inputs': {
        return <PredefinedInputsForm />;
      }
    }
  };

  const renderDialogHeaderContent = () => {
    switch (selectedPage) {
      case 'qadams-list': {
        return t('Connect apps with the agent');
      }
      case 'actions-list': {
        return (
          selectedQadam && (
            <div className="flex items-center justify-start gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={goBackToQadamsList}
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('Back')}</TooltipContent>
              </Tooltip>
              {t(selectedQadam.displayName)}
            </div>
          )
        );
      }
      case 'action-inputs': {
        return (
          selectedAction && (
            <div className="flex items-center justify-start gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={goBackToActionsList}
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('Back')}</TooltipContent>
              </Tooltip>
              {selectedAction.displayName}
            </div>
          )
        );
      }
    }
  };

  return (
    <Dialog open={showAddQadamDialog} onOpenChange={handleDialogClose}>
      <DialogContent className="w-[90vw] max-w-[750px] h-[80vh] max-h-[800px] flex flex-col overflow-hidden p-0">
        <DialogHeader className="min-h-16 flex px-4 items-start justify-center mb-0 border-b">
          <DialogTitle>{renderDialogHeaderContent()}</DialogTitle>
        </DialogHeader>

        {renderDialogMainContent()}

        {selectedPage === 'action-inputs' && (
          <DialogFooter className="border-t p-4 mt-auto">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t('Close')}
              </Button>
            </DialogClose>
            <Button
              loading={false}
              disabled={!authIsSetValue}
              type="button"
              onClick={handleSave}
            >
              {editingQadamTool ? t('Update Tool') : t('Add Tool')}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
