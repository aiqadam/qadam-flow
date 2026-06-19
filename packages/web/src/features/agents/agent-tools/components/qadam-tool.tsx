import { AgentQadamTool, mcpToolNameUtils } from '@aiqadam/shared';
import { t } from 'i18next';
import { Plus, Puzzle, X } from 'lucide-react';
import { useMemo } from 'react';

import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { stepsHooks } from '@/features/qadams/hooks/steps-hooks';
import { QadamStepMetadataWithSuggestions } from '@/features/qadams/types';

import { useQadamToolsDialogStore } from '../stores/qadams-tools';

type AgentQadamToolProps = {
  disabled?: boolean;
  tools: AgentQadamTool[];
  removeTool: (toolName: string) => void;
};

export const AgentQadamToolComponent = ({
  disabled,
  tools,
  removeTool,
}: AgentQadamToolProps) => {
  const { openAddQadamToolDialog } = useQadamToolsDialogStore();

  const { metadata } = stepsHooks.useAllStepsMetadata({
    searchQuery: '',
    type: 'action',
  });

  const piecesMetadata = useMemo(() => {
    return metadata?.filter(
      (m): m is QadamStepMetadataWithSuggestions =>
        'suggestedActions' in m && 'suggestedTriggers' in m,
    );
  }, [metadata]);

  const qadamMetadata = piecesMetadata?.find(
    (p) => p.qadamName === tools[0].pieceMetadata.qadamName,
  );

  if (!qadamMetadata) {
    return (
      <div className="flex  w-full items-center justify-between px-3 h-12  border-b last:border-0 py-2">
        <div className="flex items-center gap-3">
          <Skeleton className="h-6 w-6 rounded-md" />
          <Skeleton className="h-4 w-32" />
        </div>

        <Skeleton className="h-4 w-4 rounded-sm" />
      </div>
    );
  }

  const handleEditTool = (tool: AgentQadamTool) => {
    openAddQadamToolDialog({ page: 'action-inputs', tool });
  };

  return (
    <AccordionItem
      value={qadamMetadata.qadamName}
      className="border-b last:border-0"
    >
      <AccordionTrigger className="px-4 py-3 hover:no-underline hover:bg-accent transition-all">
        <div className="flex w-full items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-md bg-muted flex items-center justify-center">
              {qadamMetadata.logoUrl ? (
                <img
                  src={qadamMetadata.logoUrl}
                  alt={qadamMetadata.displayName}
                  className="h-5 w-5 object-contain"
                />
              ) : (
                <Puzzle className="h-5 w-5 text-muted-foreground" />
              )}
            </div>

            <span className="text-sm font-medium">
              {qadamMetadata.displayName}
            </span>
          </div>
        </div>
      </AccordionTrigger>
      <AccordionContent className="px-4 py-2">
        <div className="flex flex-wrap gap-2">
          {tools.map((tool) => {
            const toolName = qadamMetadata.suggestedActions?.find(
              (action) =>
                mcpToolNameUtils.createQadamToolName(
                  qadamMetadata.qadamName,
                  action.name,
                ) === tool.toolName,
            )?.displayName;
            return (
              <div
                key={tool.toolName}
                onClick={() => handleEditTool(tool)}
                className={`
                  group flex items-center gap-2 px-3 py-1 cursor-pointer
                  rounded-full border bg-muted/50
                  ${disabled ? 'opacity-50 pointer-events-none' : ''}
                `}
              >
                <span className="text-xs font-medium">
                  {toolName || tool.toolName}
                </span>

                <div className="flex items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        disabled={disabled}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeTool(tool.toolName);
                        }}
                        variant="ghost"
                        size="icon"
                        className="
                          size-5 p-0.5
                          text-muted-foreground
                          hover:text-destructive
                          hover:bg-destructive/10
                          transition
                        "
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('Remove tool')}</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            );
          })}
        </div>
        <Button
          variant="link"
          className="mt-4"
          size="xs"
          onClick={() =>
            openAddQadamToolDialog({
              page: 'actions-list',
              piece: qadamMetadata,
            })
          }
        >
          <Plus className="size-3 mr-1" />
          {t('Add Action')}
        </Button>
      </AccordionContent>
    </AccordionItem>
  );
};
