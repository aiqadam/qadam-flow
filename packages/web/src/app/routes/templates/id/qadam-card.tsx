import { Card, CardContent } from '@/components/ui/card';
import { QadamIconWithQadamName, qadamsHooks } from '@/features/qadams';
import { formatUtils } from '@/lib/format-utils';

type PieceCardProps = {
  qadamName: string;
};

export const PieceCard = ({ qadamName }: PieceCardProps) => {
  const { summary } = qadamsHooks.useQadamSummary({ name: qadamName });

  return (
    <Card>
      <CardContent className="p-2 w-[165px] flex items-center gap-3">
        <QadamIconWithQadamName qadamName={qadamName} size="md" />
        <span className="text-sm font-medium">
          {summary?.displayName ||
            formatUtils.convertEnumToHumanReadable(qadamName)}
        </span>
      </CardContent>
    </Card>
  );
};
