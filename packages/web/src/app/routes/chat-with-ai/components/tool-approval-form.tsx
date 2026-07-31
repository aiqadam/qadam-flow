import { isObject } from '@aiqadam/shared';
import { t } from 'i18next';
import { ShieldAlert, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';

/**
 * The approval card. Its body is the security control, not decoration.
 *
 * A card that says only "Delete flow" asks the user to authorise an action they cannot see, which is
 * worth about as much as no gate at all — the whole threat #264 exists for is a model that was talked
 * into naming the wrong argument. So the arguments the model actually asked with are shown, verbatim
 * and un-summarised, and the two buttons are the only way past it.
 */
export function ToolApprovalForm({
  displayName,
  toolName,
  toolInput,
  onApprove,
  onReject,
  onDismiss,
}: {
  displayName: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  onApprove: () => void;
  onReject: (reason?: string) => void;
  onDismiss: () => void;
}) {
  const [reason, setReason] = useState('');
  const rows = describeInput(toolInput);

  return (
    <motion.div
      className="rounded-2xl border border-border/60 bg-background p-5 shadow-[0_12px_40px_-12px_rgba(0,0,0,0.12)] dark:bg-neutral-900 dark:shadow-[0_12px_40px_-12px_rgba(0,0,0,0.45)] backdrop-blur-sm transition-colors"
      initial={{ opacity: 0, y: 16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.98 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      data-testid="tool-approval-card"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-1 min-w-0 items-start gap-3">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-500" />
          <div className="min-w-0">
            <Label className="block text-base font-semibold leading-snug text-foreground">
              {t('Approve this action?')}
            </Label>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('The assistant wants to run')} {displayName}
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={onDismiss}
          aria-label={t('Close')}
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="mt-4 rounded-xl border border-border/60 bg-muted/40 p-3">
        <div className="font-mono text-xs text-muted-foreground">
          {toolName}
        </div>
        <Separator className="my-2 bg-border/60" />
        {rows.length === 0 ? (
          <div className="text-xs text-muted-foreground">
            {t('This action takes no arguments.')}
          </div>
        ) : (
          <dl className="grid gap-1.5" data-testid="tool-approval-input">
            {rows.map((row) => (
              <div key={row.key} className="flex gap-2 text-xs">
                <dt className="shrink-0 font-medium text-muted-foreground">
                  {row.key}
                </dt>
                <dd className="min-w-0 break-all font-mono text-foreground">
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      <Textarea
        className="mt-3 min-h-[38px] text-sm"
        rows={1}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder={t('Optional: why you are declining')}
        aria-label={t('Optional: why you are declining')}
      />

      <div className="mt-3 flex gap-2">
        <Button
          className="flex-1"
          onClick={onApprove}
          data-testid="tool-approval-approve"
        >
          {t('Approve')}
        </Button>
        <Button
          variant="outline"
          className="flex-1"
          onClick={() => onReject(reason.trim() === '' ? undefined : reason)}
          data-testid="tool-approval-deny"
        >
          {t('Deny')}
        </Button>
      </div>
    </motion.div>
  );
}

/**
 * The arguments, flattened to one line each.
 *
 * Redaction is by key rather than by value, and it is here for the same reason the server never lets a
 * decrypted connection value out: nothing in the current tool set puts one in a tool argument — a
 * connection is named by its external id or label — but this card renders whatever the model sent, and
 * "no tool does that today" is not a property the card can rely on for the rest of its life. A
 * redacted row still appears, so the user can see that a field was passed without being shown it.
 */
function describeInput(input: Record<string, unknown>): InputRow[] {
  return Object.entries(input).map(([key, value]) => ({
    key,
    value: SECRETISH_KEY.test(key) ? t('(hidden)') : formatValue(value),
  }));
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value) || isObject(value)) {
    return truncate(JSON.stringify(value));
  }
  return truncate(String(value));
}

function truncate(value: string): string {
  return value.length > MAX_VALUE_CHARS
    ? `${value.slice(0, MAX_VALUE_CHARS)}…`
    : value;
}

const SECRETISH_KEY =
  /(token|secret|password|passwd|api[_-]?key|credential|authorization|bearer|private[_-]?key)/i;

// Long enough to identify a flow id, a table name or a short expression; short enough that a card
// carrying a pasted document body still fits above the composer.
const MAX_VALUE_CHARS = 240;

type InputRow = {
  key: string;
  value: string;
};
