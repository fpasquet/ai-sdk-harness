'use client';

import type { AnyExtension, Editor } from '@tiptap/core';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import type { Ref } from 'react';

import { Extension } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import HardBreak from '@tiptap/extension-hard-break';
import Mention from '@tiptap/extension-mention';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { Placeholder } from '@tiptap/extensions';
import { EditorContent, useEditor } from '@tiptap/react';
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';

/** A command or a skill of the conversation's plugins, as the prompt offers it after `/`. */
export interface PromptCommand {
  kind: 'command' | 'skill';
  /** What follows the slash: `explain`, or `plugin:explain` when two share the name. */
  name: string;
  description: string;
  argumentHint?: string;
}

/** What the prompt lets its owner do: send what is typed, as Enter does. */
export interface PromptEditorHandle {
  submit: () => void;
}

/** The commands on offer while `/<query>` is typed, and how to take one. */
interface Suggesting {
  /** Where the prompt is on the screen, the list going just above it. */
  anchor?: { bottom: number; left: number; width: number };
  items: PromptCommand[];
  pick: (command: PromptCommand) => void;
  selected: number;
}

/**
 * What the editor's extensions read of the component. The editor is made once; the component
 * keeps this up to date after each render, and the extensions read it when a key is pressed.
 */
class EditorBridge {
  commands: PromptCommand[] = [];
  disabled = false;
  placeholder = '';
  suggesting?: Suggesting;
  onSubmit: (text: string) => void = () => undefined;
  show: (suggesting?: Suggesting) => void = () => undefined;

  update(values: Partial<EditorBridge>): void {
    Object.assign(this, values);
  }

  /** Hands the message over and empties the prompt, unless there is nothing to send. */
  submit(editor: Editor): void {
    const text = textOf(editor);
    if (text === '' || this.disabled) return;
    this.onSubmit(text);
    editor.commands.clearContent(true);
  }
}

/** What a message becomes: its text, a command chip as `/<name>`, a line break as `\n`. */
const textOf = (editor: Editor): string => editor.getText({ blockSeparator: '\n' }).trim();

/** The keys of the list of commands: the arrows to choose, Tab to take. */
function onListKey(bridge: EditorBridge, { event }: SuggestionKeyDownProps): boolean {
  const current = bridge.suggesting;
  if (current === undefined || current.items.length === 0) return false;
  const count = current.items.length;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const step = event.key === 'ArrowDown' ? 1 : count - 1;
    bridge.show({ ...current, selected: (current.selected + step) % count });
    return true;
  }
  if (event.key === 'Tab') {
    const picked = current.items[current.selected];
    if (picked) current.pick(picked);
    return true;
  }
  // Escape is the plugin's own: it dismisses the list, which comes back with the next `/`.
  return false;
}

/** The `/` mention of the commands: a chip that reads `/<name>` in the text sent. */
function commandMention(bridge: EditorBridge): AnyExtension {
  return Mention.extend({ name: 'command' }).configure({
    HTMLAttributes: { class: 'rounded bg-accent px-1 py-0.5 font-mono text-sm font-medium' },
    renderText: ({ node }) => `/${String(node.attrs.id)}`,
    renderHTML: ({ node, options }) => [
      'span',
      options.HTMLAttributes,
      `/${String(node.attrs.id)}`,
    ],
    suggestion: {
      char: '/',
      // A command is one only when it opens the message: the server expands nothing else.
      allow: ({ range }) => range.from === 1,
      items: ({ query }) => bridge.commands.filter(({ name }) => name.startsWith(query)),
      render: () => {
        const show = ({ command, items }: SuggestionProps<PromptCommand>) =>
          bridge.show({
            items,
            pick: (picked) => command({ id: picked.name }),
            selected: Math.min(bridge.suggesting?.selected ?? 0, Math.max(items.length - 1, 0)),
          });
        return {
          onStart: show,
          onUpdate: show,
          onExit: () => bridge.show(undefined),
          onKeyDown: (props) => onListKey(bridge, props),
        };
      },
    },
  });
}

/** A plain-text editor, paragraphs and line breaks, with the commands as `/` mentions. */
function extensionsFor(bridge: EditorBridge): AnyExtension[] {
  return [
    Document,
    Paragraph,
    Text,
    HardBreak,
    Placeholder.configure({ placeholder: () => bridge.placeholder }),
    commandMention(bridge),
    Extension.create({
      name: 'submitOnEnter',
      // Before the core keymap, which would split the paragraph.
      priority: 1000,
      addKeyboardShortcuts: () => ({
        Enter: ({ editor }) => {
          const open = bridge.suggesting;
          const picked = open?.items[open.selected];
          if (picked) open.pick(picked);
          else bridge.submit(editor);
          return true;
        },
      }),
    }),
  ];
}

/**
 * The prompt, on Tiptap: `/` at the very start of a message offers the commands and the skills of
 * the conversation's plugins (the arrows to choose, Enter or Tab to take one, Escape to leave the
 * list). A command taken becomes a chip, sent as `/<name>`, which the server expands. Enter sends
 * the message, Shift+Enter breaks the line.
 */
export function PromptEditor({
  commands,
  disabled,
  onChange,
  onSubmit,
  placeholder,
  ref,
}: {
  commands: PromptCommand[];
  disabled: boolean;
  /** The text as it would be sent, at each change. */
  onChange: (text: string) => void;
  /** Enter: the text to send. The prompt empties itself once it is handed over. */
  onSubmit: (text: string) => void;
  placeholder: string;
  ref?: Ref<PromptEditorHandle>;
}) {
  const [suggesting, setSuggesting] = useState<Suggesting>();
  const box = useRef<HTMLDivElement>(null);
  // Called by the editor as `/` is typed: the prompt's place is read then, never while rendering.
  const show = useCallback((next?: Suggesting) => {
    const rect = box.current?.getBoundingClientRect();
    setSuggesting(
      next &&
        rect && {
          ...next,
          anchor: { bottom: window.innerHeight - rect.top + 8, left: rect.left, width: rect.width },
        },
    );
  }, []);
  const [bridge] = useState(() => new EditorBridge());
  const [extensions] = useState(() => extensionsFor(bridge));

  useEffect(() => {
    bridge.update({ commands, disabled, onSubmit, placeholder, show, suggesting });
  }, [bridge, commands, disabled, onSubmit, placeholder, show, suggesting]);

  const editor = useEditor({
    editorProps: {
      attributes: {
        'aria-label': 'Message to the agent',
        class: 'max-h-48 min-h-16 w-full overflow-y-auto px-3 py-3 text-sm outline-none',
      },
    },
    extensions,
    immediatelyRender: false,
    onUpdate: ({ editor: current }) => onChange(textOf(current)),
  });

  useImperativeHandle(ref, () => ({ submit: () => editor && bridge.submit(editor) }), [
    bridge,
    editor,
  ]);

  // The placeholder is read at each redraw: an empty prompt shows the new one.
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr);
  }, [editor, placeholder]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  const anchor = suggesting?.anchor;
  return (
    <div className="w-full min-w-0" ref={box}>
      {suggesting &&
        suggesting.items.length > 0 &&
        anchor &&
        createPortal(
          <ul
            className="fixed z-50 divide-y rounded-md border bg-popover text-sm shadow-md"
            role="listbox"
            // Out of the prompt's frame, which clips what overflows it.
            style={anchor}
          >
            {suggesting.items.map((command, index) => (
              <li aria-selected={index === suggesting.selected} key={command.name} role="option">
                <button
                  className={cn(
                    'flex w-full items-baseline gap-2 px-3 py-1.5 text-left hover:bg-accent',
                    index === suggesting.selected && 'bg-accent',
                  )}
                  onMouseDown={(event) => {
                    // Keep the editor's focus and selection: the chip goes where the `/` is.
                    event.preventDefault();
                    suggesting.pick(command);
                  }}
                  type="button"
                >
                  <span className="shrink-0 font-mono font-medium whitespace-nowrap">
                    /{command.name}
                  </span>
                  {command.kind === 'skill' && (
                    <span className="rounded-sm bg-muted px-1 text-[10px] tracking-wide text-muted-foreground uppercase">
                      skill
                    </span>
                  )}
                  {command.argumentHint && (
                    <span className="font-mono text-xs text-muted-foreground">
                      {command.argumentHint}
                    </span>
                  )}
                  <span className="truncate text-xs text-muted-foreground">
                    {command.description}
                  </span>
                </button>
              </li>
            ))}
          </ul>,
          document.body,
        )}
      <EditorContent className={cn(disabled && 'opacity-50')} editor={editor} />
    </div>
  );
}
