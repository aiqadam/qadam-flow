import { qadamsHooks } from '../hooks/qadams-hooks';

import { QadamIcon } from './qadam-icon';

type QadamIconWithQadamNameProps = {
  qadamName: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  border?: boolean;
  showTooltip?: boolean;
};

const QadamIconWithQadamName = ({
  qadamName,
  size = 'md',
  border = true,
  showTooltip = true,
}: QadamIconWithQadamNameProps) => {
  const { summary } = qadamsHooks.useQadamSummary({ name: qadamName });

  return (
    <QadamIcon
      size={size}
      border={border}
      displayName={summary?.displayName}
      logoUrl={summary?.logoUrl}
      showTooltip={showTooltip}
    />
  );
};

export { QadamIconWithQadamName };
