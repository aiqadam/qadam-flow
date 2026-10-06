import React from 'react';

import { ApSidebarToggle } from '@/components/custom/ap-sidebar-toggle';
import { Separator } from '@/components/ui/separator';

export const CenteredPage = ({
  title,
  description,
  actions,
  showSidebarToggle = false,
  children,
}: {
  title: string;
  description: React.ReactNode;
  actions?: React.ReactNode;
  showSidebarToggle?: boolean;
  children: React.ReactNode;
}) => {
  return (
    <div className="w-full max-w-[40rem] mx-auto py-6">
      <div className="flex items-start justify-between gap-4">
        {showSidebarToggle && <ApSidebarToggle />}
        <div className="flex flex-1 flex-col gap-1">
          <h1 className="text-xl font-medium">{title}</h1>
          <div className="text-sm text-muted-foreground">{description}</div>
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
      <Separator className="my-4" />
      {children}
    </div>
  );
};
