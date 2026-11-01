import type { RefObject } from "react";
import { EditorContent, type Editor } from "@tiptap/react";
import { COARSE_POINTER_TEXT_BASE_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { cn } from "@/lib/utils";
import {
  PromptMentionLinkContext,
  type PromptMentionLinkResolver,
} from "./editor/prompt-mention-link";

export const COMPOSER_EDITOR_AVAILABLE_HEIGHT_PROPERTY =
  "--composer-editor-available-height";

export type ComposerEditorLayout = "thread" | "root-compose";

const COMPOSER_EDITOR_MAX_HEIGHT_BY_LAYOUT: Record<
  ComposerEditorLayout,
  string
> = {
  thread: "calc(50dvh - 3rem)",
  "root-compose": "calc(70dvh - 3rem)",
};

export function blurPromptEditor(editor: Editor | null | undefined): void {
  editor?.view.dom.blur();
  window.getSelection()?.removeAllRanges();
}

export function ComposerEditorSlot({
  editor,
  scrollContainerRef,
  inputLocked,
  isCompactLayout,
  minHeight,
  layout,
  resolveMentionLink,
  suggestion = null,
}: {
  editor: Editor | null;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  inputLocked: boolean;
  isCompactLayout: boolean;
  minHeight: number;
  layout: ComposerEditorLayout;
  resolveMentionLink: PromptMentionLinkResolver | undefined;
  suggestion?: { text: string; descriptionId: string } | null;
}) {
  return (
    <div
      ref={scrollContainerRef}
      data-promptbox-editor-scroll=""
      aria-busy={inputLocked || undefined}
      className={cn(
        "w-full overflow-y-auto bg-transparent px-4 pb-1 pr-14 pt-3 outline-none",
        COARSE_POINTER_TEXT_BASE_CLASS,
        "leading-relaxed",
        isCompactLayout && "h-12 overflow-hidden pb-0 pr-2 pt-0",
      )}
      style={{
        minHeight: isCompactLayout ? "48px" : `${minHeight}px`,
        height: isCompactLayout ? "48px" : undefined,
        maxHeight: isCompactLayout
          ? "48px"
          : `min(${COMPOSER_EDITOR_MAX_HEIGHT_BY_LAYOUT[layout]}, var(${COMPOSER_EDITOR_AVAILABLE_HEIGHT_PROPERTY}, 100dvh))`,
      }}
    >
      <PromptMentionLinkContext.Provider value={resolveMentionLink ?? null}>
        <div className="grid min-h-full min-w-0 grid-cols-[minmax(0,1fr)]">
          <EditorContent
            editor={editor}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              if (editor === null || editor.isEditable) return;
              event.preventDefault();
              blurPromptEditor(editor);
            }}
            data-promptbox-editor-content=""
            data-promptbox-compact-content={isCompactLayout ? "" : undefined}
            className={cn(
              "col-start-1 row-start-1 h-full min-h-full min-w-0",
              isCompactLayout && "flex items-center",
              "[&_.ProseMirror]:min-h-full [&_.ProseMirror]:leading-[1.7] [&_.ProseMirror]:outline-none",
              "[&_.ProseMirror_p]:m-0",
              "[&_.ProseMirror_blockquote]:my-1 [&_.ProseMirror_blockquote]:border-l-2 [&_.ProseMirror_blockquote]:border-surface-selected-border [&_.ProseMirror_blockquote]:pl-3 [&_.ProseMirror_blockquote]:text-muted-foreground",
              "[&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none",
              "[&_.ProseMirror_p.is-editor-empty:first-child::before]:float-left",
              "[&_.ProseMirror_p.is-editor-empty:first-child::before]:h-0",
              "[&_.ProseMirror_p.is-editor-empty:first-child::before]:text-subtle-foreground",
              "[&_.ProseMirror_p.is-editor-empty:first-child::before]:font-light",
              "[&_.ProseMirror_p.is-editor-empty:first-child::before]:opacity-70",
              suggestion &&
                "[&_.ProseMirror_p.is-editor-empty:first-child::before]:hidden",
            )}
          />
          {suggestion ? (
            <>
              <div
                aria-hidden="true"
                data-promptbox-suggestion=""
                className={cn(
                  "pointer-events-none col-start-1 row-start-1 min-w-0 whitespace-pre-wrap break-words font-light leading-[1.7] text-subtle-foreground opacity-70",
                  isCompactLayout && "self-center truncate whitespace-nowrap",
                )}
              >
                {suggestion.text}
              </div>
              <span id={suggestion.descriptionId} className="sr-only">
                Suggested next prompt: {suggestion.text}. Press Tab or right
                arrow to use it as an editable draft. It will not be sent.
              </span>
            </>
          ) : null}
        </div>
      </PromptMentionLinkContext.Provider>
    </div>
  );
}
