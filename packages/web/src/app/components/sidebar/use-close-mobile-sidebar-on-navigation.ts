import { useEffect } from 'react';
import { useLocation } from 'react-router';

import { useSidebar } from '@/components/ui/sidebar-shadcn';

// Sibling routes that render the same layout (e.g. /impact and /leaderboard) keep the
// SidebarProvider mounted across navigation, so the mobile Sheet would stay open over the
// page the user just navigated to. Navigation can start from any control inside the
// Sheet (menu items, project list, search, user menu), so this syncs with the router's
// location rather than wiring a close call into each of them.
export function useCloseMobileSidebarOnNavigation() {
  const { pathname } = useLocation();
  const { setOpenMobile } = useSidebar();

  useEffect(() => {
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);
}
