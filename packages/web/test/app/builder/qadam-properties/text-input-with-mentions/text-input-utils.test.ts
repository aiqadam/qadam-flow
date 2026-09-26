import { describe, expect, it } from 'vitest';

import { textMentionUtils } from '@/app/builder/qadam-properties/text-input-with-mentions/text-input-utils';

describe('textMentionUtils.parseLabelFromMention — flattenNestedKeys', () => {
  it('extracts the step name from the [\'output\']-nested form', () => {
    const label = textMentionUtils.parseLabelFromMention(
      "{{flattenNestedKeys(step_1['output'], ['items'])}}",
      [],
      [],
    );
    // Regex matched and pulled out the clean step name (not "flattenNestedKeys(step_1").
    expect(label.displayText).toBe('(Missing) step_1');
  });

  it('still parses the legacy (un-nested) form for backward compatibility', () => {
    const label = textMentionUtils.parseLabelFromMention(
      "{{flattenNestedKeys(step_1, ['items'])}}",
      [],
      [],
    );
    expect(label.displayText).toBe('(Missing) step_1');
  });
});

describe('textMentionUtils.parseLabelFromMention — $t translation mentions', () => {
  it('renders a plain key as "Text · key", never falling through to the step-name path', () => {
    const label = textMentionUtils.parseLabelFromMention(
      "{{$t['welcome.title']}}",
      [],
      [],
    );
    expect(label.displayText).toBe('Text · welcome.title');
    expect(label.displayText).not.toContain('Missing');
  });

  it('keeps a dot-separated key intact — the generic step-path parser would otherwise split on "."', () => {
    const label = textMentionUtils.parseLabelFromMention(
      "{{$t['a.b.c']}}",
      [],
      [],
    );
    expect(label.displayText).toBe('Text · a.b.c');
  });

  it('appends "[dynamic locale]" when a second (locale) bracket is present', () => {
    const label = textMentionUtils.parseLabelFromMention(
      "{{$t['welcome.title'][loop['item'].lang]}}",
      [],
      [],
    );
    expect(label.displayText).toBe('Text · welcome.title [dynamic locale]');
  });
});

const convert = (text: string) =>
  textMentionUtils.convertTextToTipTapJsonContent(text, [], []);

describe('textMentionUtils.convertTextToTipTapJsonContent', () => {
  describe('unclosed "{{" does not hang the tokenizer', () => {
    // Before the fix these inputs spun forever in tokenizeExpression and froze
    // the tab; an infinite loop now surfaces as a vitest timeout instead.
    it.each(['{{', '{{foo', 'text {{', '{{foo bar baz', '{{a}} {{b'])(
      'returns for %j',
      (input) => {
        expect(() => convert(input)).not.toThrow();
        expect(convert(input)).toBeDefined();
      },
    );

    it('keeps unclosed "{{" as literal text', () => {
      const paragraphs = convert('{{foo');
      const text = paragraphs[0].content
        .filter((node) => node.type === 'text')
        .map((node) => node.text)
        .join('');
      expect(text).toBe('{{foo');
    });
  });

  it('renders a complete "{{ ... }}" as a mention node', () => {
    const paragraphs = convert('{{step_1.field}}');
    const hasMention = paragraphs[0].content.some(
      (node) => node.type === 'mention',
    );
    expect(hasMention).toBe(true);
  });
});
