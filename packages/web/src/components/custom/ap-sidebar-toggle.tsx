import { t } from 'i18next';

import { PanelLeftCloseIcon } from '@/components/icons/panel-left-close';
import { PanelLeftOpenIcon } from '@/components/icons/panel-left-open';
import { Button } from '@/components/ui/button';
import { useSidebar } from '@/components/ui/sidebar-shadcn';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export const ApSidebarToggle = () => {
  const { open, openMobile, isMobile, toggleSidebar } = useSidebar();
  // Mobile renders the sidebar as a Sheet driven by `openMobile`; `open` is
  // the desktop state, which nothing renders from below the breakpoint.
  const isOpen = isMobile ? openMobile : open;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" onClick={toggleSidebar}>
          {isOpen ? (
            <PanelLeftCloseIcon size={16} />
          ) : (
            <PanelLeftOpenIcon size={16} />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {isOpen ? t('Close Sidebar') : t('Open Sidebar')}
      </TooltipContent>
    </Tooltip>
  );
};
