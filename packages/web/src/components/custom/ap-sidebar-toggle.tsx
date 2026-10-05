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
  // `open` is the desktop rail state; the mobile Sheet opens from `openMobile`.
  const isOpen = isMobile ? openMobile : open;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleSidebar}
          data-testid="sidebar-toggle"
        >
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
