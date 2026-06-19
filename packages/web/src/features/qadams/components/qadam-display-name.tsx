import { qadamsHooks } from '../hooks/qadams-hooks';

type QadamDisplayNameProps = {
  qadamName: string;
  fallback?: string;
};

const QadamDisplayName = ({ qadamName, fallback }: QadamDisplayNameProps) => {
  const { summary } = qadamsHooks.useQadamSummary({ name: qadamName });

  return <span>{summary?.displayName || fallback || qadamName}</span>;
};

export { QadamDisplayName };
