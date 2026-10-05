import { PageHeader } from '@/components/custom/page-header';
import { useIsMobile } from '@/hooks/use-mobile';

export const DashboardPageHeader = ({
  title,
  children,
  description,
}: {
  title: React.ReactNode;
  children?: React.ReactNode;
  description?: React.ReactNode;
}) => {
  const isMobile = useIsMobile();
  // DashboardPageHeader only renders on /platform/* routes, which PlatformLayout wraps in
  // SidebarProvider, so the toggle's useSidebar() is always in context here. That provider is pinned
  // open, so on desktop the toggle would write to a state nothing renders from; show it on mobile
  // only. Making the platform sidebar collapsible on desktop is a separate decision (#714).
  return (
    <PageHeader
      title={title}
      description={description}
      rightContent={children}
      showSidebarToggle={isMobile}
      className="min-w-full"
    />
  );
};
