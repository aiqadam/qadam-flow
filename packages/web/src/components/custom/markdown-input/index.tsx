import { Blockquote } from '@tiptap/extension-blockquote';
import { Bold } from '@tiptap/extension-bold';
import { Code } from '@tiptap/extension-code';
import { CodeBlock } from '@tiptap/extension-code-block';
import Document from '@tiptap/extension-document';
import { Heading } from '@tiptap/extension-heading';
import { HorizontalRule } from '@tiptap/extension-horizontal-rule';
import { Image } from '@tiptap/extension-image';
import { Italic } from '@tiptap/extension-italic';
import { Link } from '@tiptap/extension-link';
import { BulletList, ListItem, OrderedList } from '@tiptap/extension-list';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Strike } from '@tiptap/extension-strike';
import { TableKit } from '@tiptap/extension-table';
import Text from '@tiptap/extension-text';
import { Underline } from '@tiptap/extension-underline';
import { Focus, UndoRedo } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import { Editor, EditorContent, Extension, useEditor } from '@tiptap/react';
import React, { useImperativeHandle, useState } from 'react';

import { cn } from '@/lib/utils';

export const MarkdownInput = React.forwardRef<
  Editor | null,
  MarkdownInputProps
>(
  (
    {
      initialValue,
      onChange,
      className,
      disabled,
      placeholder,
      placeholderClassName,
      onlyEditableOnDoubleClick,
    }: MarkdownInputProps,
    ref: React.Ref<Editor | null>,
  ) => {
    const [showTextCursor, setShowTextCursor] = useState(
      !onlyEditableOnDoubleClick && !disabled,
    );
    const [hasContentError, setHasContentError] = useState(false);
    const editor = useEditor({
      extensions: [
        Document,
        Heading,
        Code,
        CodeBlock,
        Blockquote,
        HorizontalRule,
        BulletList,
        OrderedList,
        Text,
        ListItem,
        Link.configure({
          // Notes are edited in place, so a click must place the cursor rather than navigate.
          openOnClick: false,
          // Documented intent only: the extension's built-in allow-list already rejects unsafe
          // schemes (javascript:, data:); declared protocols are appended to it, not a narrowing.
          protocols: ['http', 'https', 'mailto'],
        }),
        Focus.configure({
          className: 'has-focus',
          mode: 'all',
        }),
        Markdown,
        Image.configure({
          inline: true,
        }),
        TableKit,
        Strike,
        Bold,
        Italic,
        Underline,
        EmptyLineParagraphExtension,
        UndoRedo.configure({
          depth: 10,
        }),
        Extension.create({
          addKeyboardShortcuts() {
            return {
              'Cmd-Enter'() {
                editor.commands.enter();
                return true;
              },
              'Ctrl-Enter'() {
                editor.commands.enter();
                return true;
              },
              'Shift-Enter'() {
                editor.commands.enter();
                return true;
              },
            };
          },
        }),
      ],
      content: initialValue,
      contentType: 'markdown',
      enableContentCheck: true,
      editable: !disabled && !onlyEditableOnDoubleClick,
      onContentError: () => {
        setHasContentError(true);
      },
      onUpdate: ({ editor }) => {
        onChange(editor.getMarkdown());
      },
      editorProps: {
        attributes: {
          class: cn(
            'bg-transparent text-inherit outline-none border-none p-0 m-0',
            className,
          ),
          spellcheck: 'false',
        },
      },
      onFocus: () => {
        setShowTextCursor(true);
      },
      onBlur: () => {
        setShowTextCursor(false);
        window.getSelection()?.removeAllRanges();
        if (onlyEditableOnDoubleClick) {
          editor.setEditable(false, false);
        }
      },
      parseOptions: {
        preserveWhitespace: 'full',
      },
    });
    useImperativeHandle(ref, () => editor, [editor]);
    // tiptap replaces unparseable content with an empty doc it would then save over
    // on the first keystroke; show the stored markdown read-only instead.
    if (hasContentError) {
      return (
        <div className={cn('relative h-full nodrag nopan nowheel', className)}>
          <div className="whitespace-pre-wrap break-words text-inherit">
            {initialValue}
          </div>
        </div>
      );
    }
    const showPlaceholder =
      editor.getMarkdown().trim().replaceAll('<br>', '') === '' &&
      !disabled &&
      !editor.isEditable;
    return (
      <div
        className={cn('relative h-full', {
          //gotta add this nodrag nopan to prevent dnd-kit and React Flow interference with selection
          'nodrag nopan nowheel cursor-text select-text': showTextCursor,
        })}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            editor.commands.blur();
          }
        }}
        onDoubleClick={() => {
          if (onlyEditableOnDoubleClick && !disabled) {
            editor.setEditable(true);
          }
        }}
      >
        {/**didn't use tiptap placeholder because it disappears when the editor is not editable */}
        {showPlaceholder && (
          <div
            className={cn(
              placeholderClassName,
              'opacity-75 pointer-events-none  absolute  z-50 ',
            )}
          >
            {' '}
            {placeholder}{' '}
          </div>
        )}
        <EditorContent
          className={'h-full'}
          key={disabled ? 'disabled' : 'enabled'}
          editor={editor}
        />
      </div>
    );
  },
);

type MarkdownInputProps = {
  initialValue: string;
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
  onlyEditableOnDoubleClick?: boolean;
  placeholderClassName?: string;
};

MarkdownInput.displayName = 'MarkdownInput';

//https://github.com/ueberdosis/tiptap/issues/7269#issuecomment-3669021079
const EmptyLineParagraphExtension = Paragraph.extend({
  renderMarkdown: (node, helpers) => {
    const view = helpers.renderChildren(node.content ?? []);
    if (!view || view.trim() === '') {
      return '<br>';
    }
    return view;
  },
});
