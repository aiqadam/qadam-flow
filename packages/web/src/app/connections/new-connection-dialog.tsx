import { QadamMetadataModelSummary } from '@aiqadam/qadams-framework';
import { AppConnectionWithoutSensitiveData, isNil } from '@aiqadam/shared';
import { t } from 'i18next';
import React, { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { qadamsHooks } from '@/features/qadams';

import { CreateOrEditConnectionDialog } from './create-edit-connection-dialog';

type NewConnectionDialogProps = {
  onConnectionCreated: (connection: AppConnectionWithoutSensitiveData) => void;
  children: React.ReactNode;
  isGlobalConnection: boolean;
};

const NewConnectionDialog = React.memo(
  ({
    onConnectionCreated,
    children,
    isGlobalConnection,
  }: NewConnectionDialogProps) => {
    const [dialogTypesOpen, setDialogTypesOpen] = useState(false);
    const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
    const [selectedQadam, setSelectedPiece] = useState<
      QadamMetadataModelSummary | undefined
    >(undefined);
    const { qadams, isLoading } = qadamsHooks.useQadams({});
    const [searchTerm, setSearchTerm] = useState('');

    const filteredQadams = qadams?.filter((piece) => {
      return (
        !isNil(piece.auth) &&
        piece.displayName.toLowerCase().includes(searchTerm.toLowerCase())
      );
    });

    const clickPiece = (name: string) => {
      setDialogTypesOpen(false);
      setSelectedPiece(qadams?.find((piece) => piece.name === name));
      setConnectionDialogOpen(true);
    };

    return (
      <>
        {selectedQadam && (
          <CreateOrEditConnectionDialog
            reconnectConnection={null}
            piece={selectedQadam}
            open={connectionDialogOpen}
            isGlobalConnection={isGlobalConnection}
            key={`CreateOrEditConnectionDialog-open-${connectionDialogOpen}`}
            setOpen={(open, connection) => {
              setConnectionDialogOpen(open);
              if (connection) {
                onConnectionCreated(connection);
              }
            }}
          ></CreateOrEditConnectionDialog>
        )}
        <Dialog
          open={dialogTypesOpen}
          onOpenChange={(open) => {
            setDialogTypesOpen(open);
            setSearchTerm('');
          }}
        >
          <DialogTrigger asChild>{children}</DialogTrigger>
          <DialogContent className="min-w-[700px] max-w-[700px] h-[680px] max-h-[680px] flex flex-col">
            <DialogHeader>
              <DialogTitle>{t('New Connection')}</DialogTitle>
            </DialogHeader>
            <div className="mb-4">
              <Input
                placeholder={t('Search')}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            <ScrollArea className="grow overflow-y-auto ">
              <div className="grid grid-cols-4 gap-4">
                {(isLoading ||
                  (filteredQadams && filteredQadams.length === 0)) && (
                  <div className="text-center">{t('No qadams found')}</div>
                )}
                {!isLoading &&
                  filteredQadams &&
                  filteredQadams.map((piece, index) => (
                    <div
                      key={index}
                      onClick={() => clickPiece(piece.name)}
                      className="border p-2 h-[150px] w-[150px] flex flex-col items-center justify-center hover:bg-accent hover:text-accent-foreground cursor-pointer rounded-lg"
                    >
                      <img
                        className="w-[40px] h-[40px]"
                        src={piece.logoUrl}
                      ></img>
                      <div className="mt-2 text-center text-md">
                        {piece.displayName}
                      </div>
                    </div>
                  ))}
              </div>
            </ScrollArea>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="ghost">
                  {t('Close')}
                </Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  },
);

NewConnectionDialog.displayName = 'NewConnectionDialog';
export { NewConnectionDialog };
