import {
  internal_DO_NOT_USE_usePromptSuggestions as usePromptSuggestions,
  useSdk,
  type PluginComposerApi,
} from "@get-bb/plugin-sdk/app";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@/components/ui/chrome-style-tokens";
import { cn } from "@/lib/utils";
import { isDraftEmpty } from "./composer-draft";

type SuggestionState = NonNullable<ReturnType<typeof usePromptSuggestions>>;
type SuggestionMode = SuggestionState["mode"];

const MODE_LABELS: Record<SuggestionMode, string> = {
  automatic: "Automatic",
  button: "Button",
  off: "Off",
};

export function useComposerPromptSuggestion({
  composer,
  blocked,
  hidden,
}: {
  composer: PluginComposerApi;
  blocked: boolean;
  hidden: boolean;
}) {
  const threadId =
    composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const state = usePromptSuggestions({ threadId });
  const sdk = useSdk();
  const descriptionId = useId();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [error, setError] = useState<{
    threadId: string;
    message: string;
    sourceTurnId?: string | null;
  } | null>(null);
  const [operation, setOperation] = useState<{
    threadId: string;
    kind: "request" | "configure";
  } | null>(null);
  const accepting = useRef(new Set<string>());
  const requesting = useRef(new Set<string>());
  const configuring = useRef(new Set<string>());
  const intentRevision = useRef(0);
  const dismissedSource = useRef<string | null>(null);
  const mounted = useRef(true);
  const latest = useRef({ composer, threadId, state, blocked, hidden });
  useLayoutEffect(() => {
    latest.current = { composer, threadId, state, blocked, hidden };
  }, [composer, threadId, state, blocked, hidden]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const isCurrent = useCallback(
    (targetThreadId: string, key: string) =>
      mounted.current &&
      latest.current.threadId === targetThreadId &&
      latest.current.composer.key === key,
    [],
  );
  const suggestionKey =
    threadId && state?.sourceTurnId
      ? `${threadId}:${state.sourceTurnId}`
      : null;
  const suggestion =
    !blocked &&
    !hidden &&
    !(operation?.threadId === threadId && operation.kind === "configure") &&
    state?.eligible &&
    state.mode !== "off" &&
    state.text &&
    state.sourceTurnId &&
    suggestionKey !== dismissed &&
    isDraftEmpty(composer.draft)
      ? { text: state.text, sourceTurnId: state.sourceTurnId }
      : null;

  const accept = useCallback(async () => {
    const source = latest.current;
    if (
      accepting.current.has(source.composer.key) ||
      configuring.current.has(source.composer.key) ||
      !source.threadId ||
      source.blocked ||
      source.hidden ||
      !source.state?.eligible ||
      source.state.mode === "off" ||
      !source.state.text ||
      !source.state.sourceTurnId ||
      !isDraftEmpty(source.composer.draft)
    )
      return false;
    const targetThreadId = source.threadId;
    const targetKey = source.composer.key;
    const candidate = {
      text: source.state.text,
      sourceTurnId: source.state.sourceTurnId,
    };
    if (
      dismissedSource.current === `${targetThreadId}:${candidate.sourceTurnId}`
    )
      return false;
    const sourceDraft = source.composer.draft;
    const sourceRevision = intentRevision.current;
    const focusedElement = document.activeElement;
    accepting.current.add(targetKey);
    try {
      const current = await sdk.threads.experimental_promptSuggestions.get({
        threadId: targetThreadId,
      });
      if (
        !isCurrent(targetThreadId, targetKey) ||
        sourceRevision !== intentRevision.current ||
        configuring.current.has(targetKey) ||
        latest.current.blocked ||
        latest.current.hidden ||
        latest.current.state?.sourceTurnId !== candidate.sourceTurnId ||
        latest.current.state.mode === "off" ||
        !current.eligible ||
        current.mode === "off" ||
        current.pending ||
        current.sourceTurnId !== candidate.sourceTurnId ||
        current.text !== candidate.text
      )
        return false;
      let inserted = false;
      source.composer.replace((draft) => {
        if (source.composer.draft !== sourceDraft || !isDraftEmpty(draft))
          return draft;
        inserted = true;
        return { text: candidate.text, mentions: [] };
      });
      if (inserted) {
        if (document.activeElement === focusedElement) source.composer.focus();
        dismissedSource.current = `${targetThreadId}:${candidate.sourceTurnId}`;
        setDismissed(`${targetThreadId}:${candidate.sourceTurnId}`);
        void sdk.threads.experimental_promptSuggestions
          .dismiss({
            threadId: targetThreadId,
            sourceTurnId: candidate.sourceTurnId,
          })
          .catch(() => {});
      }
      return inserted;
    } catch (cause) {
      if (isCurrent(targetThreadId, targetKey))
        setError({
          threadId: targetThreadId,
          message:
            cause instanceof Error
              ? cause.message
              : "Could not accept the suggestion.",
        });
      return false;
    } finally {
      accepting.current.delete(targetKey);
    }
  }, [isCurrent, sdk]);

  const dismiss = useCallback(() => {
    const source = latest.current;
    if (!source.threadId || !source.state?.sourceTurnId) return;
    const targetThreadId = source.threadId;
    const targetKey = source.composer.key;
    intentRevision.current += 1;
    dismissedSource.current = `${targetThreadId}:${source.state.sourceTurnId}`;
    setDismissed(`${targetThreadId}:${source.state.sourceTurnId}`);
    setError(null);
    void sdk.threads.experimental_promptSuggestions
      .dismiss({
        threadId: targetThreadId,
        sourceTurnId: source.state.sourceTurnId,
      })
      .catch((cause: unknown) => {
        if (isCurrent(targetThreadId, targetKey))
          setError({
            threadId: targetThreadId,
            message:
              cause instanceof Error
                ? cause.message
                : "Could not dismiss the suggestion.",
          });
      });
  }, [isCurrent, sdk]);

  const request = useCallback(async () => {
    const source = latest.current;
    if (
      requesting.current.has(source.composer.key) ||
      configuring.current.has(source.composer.key) ||
      !source.threadId ||
      source.blocked ||
      !source.state?.eligible ||
      source.state.mode !== "button" ||
      !isDraftEmpty(source.composer.draft)
    )
      return;
    const targetThreadId = source.threadId;
    const targetKey = source.composer.key;
    const sourceRevision = ++intentRevision.current;
    const sourceTurnId = source.state.sourceTurnId;
    requesting.current.add(targetKey);
    dismissedSource.current = null;
    setDismissed(null);
    setError(null);
    setOperation({ threadId: targetThreadId, kind: "request" });
    try {
      const result = await sdk.threads.experimental_promptSuggestions.request({
        threadId: targetThreadId,
      });
      if (
        isCurrent(targetThreadId, targetKey) &&
        sourceRevision === intentRevision.current &&
        result.mode === "button" &&
        result.sourceTurnId === sourceTurnId &&
        !result.text
      ) {
        setError({
          threadId: targetThreadId,
          sourceTurnId,
          message: "No next-prompt suggestion this time.",
        });
      }
    } catch (cause) {
      if (
        isCurrent(targetThreadId, targetKey) &&
        sourceRevision === intentRevision.current &&
        latest.current.state?.mode === "button"
      )
        setError({
          threadId: targetThreadId,
          sourceTurnId,
          message:
            cause instanceof Error
              ? cause.message
              : "Could not generate a suggestion.",
        });
    } finally {
      requesting.current.delete(targetKey);
      if (isCurrent(targetThreadId, targetKey))
        setOperation((current) =>
          current?.threadId === targetThreadId && current.kind === "request"
            ? null
            : current,
        );
    }
  }, [isCurrent, sdk]);

  const configure = useCallback(
    async (mode: SuggestionMode) => {
      const source = latest.current;
      if (
        configuring.current.has(source.composer.key) ||
        !source.threadId ||
        source.blocked ||
        !source.state?.eligible
      )
        return;
      const targetThreadId = source.threadId;
      const targetKey = source.composer.key;
      intentRevision.current += 1;
      configuring.current.add(targetKey);
      setOperation({ threadId: targetThreadId, kind: "configure" });
      setError(null);
      try {
        await sdk.threads.experimental_promptSuggestions.configure({
          threadId: targetThreadId,
          mode,
        });
        if (isCurrent(targetThreadId, targetKey)) setError(null);
      } catch (cause) {
        if (isCurrent(targetThreadId, targetKey))
          setError({
            threadId: targetThreadId,
            message:
              cause instanceof Error
                ? cause.message
                : "Could not change suggestion mode.",
          });
      } finally {
        configuring.current.delete(targetKey);
        if (isCurrent(targetThreadId, targetKey))
          setOperation((current) =>
            current?.threadId === targetThreadId && current.kind === "configure"
              ? null
              : current,
          );
      }
    },
    [isCurrent, sdk],
  );

  const hasSuggestion = suggestion !== null;
  const handleKey = useCallback(
    (event: KeyboardEvent) => {
      if (
        !hasSuggestion ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.shiftKey ||
        event.altKey ||
        event.metaKey ||
        event.ctrlKey
      )
        return false;
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
        return true;
      }
      if (event.key !== "Tab" && event.key !== "ArrowRight") return false;
      event.preventDefault();
      void accept();
      return true;
    },
    [accept, dismiss, hasSuggestion],
  );

  return {
    state,
    suggestion,
    descriptionId,
    accept,
    dismiss,
    request,
    configure,
    handleKey,
    error:
      error?.threadId === threadId &&
      !blocked &&
      (error.sourceTurnId === undefined ||
        error.sourceTurnId === state?.sourceTurnId)
        ? error.message
        : null,
    configuring:
      operation?.threadId === threadId && operation.kind === "configure",
    pending:
      state?.pending === true ||
      (operation?.threadId === threadId && operation.kind === "request"),
  };
}

export function PromptSuggestionControls({
  controller,
  disabled,
  empty,
}: {
  controller: ReturnType<typeof useComposerPromptSuggestion>;
  disabled: boolean;
  empty: boolean;
}) {
  const {
    state,
    suggestion,
    configure,
    request,
    dismiss,
    accept,
    pending,
    configuring,
  } = controller;
  if (!state?.eligible) return null;
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex items-center gap-0.5">
        <DropdownMenu modal={false}>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  disabled={disabled || configuring}
                  aria-label={`Prompt suggestions: ${MODE_LABELS[state.mode]}`}
                  className={cn(
                    CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
                    COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS,
                  )}
                >
                  <Icon name="Sparkles" className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">
              Prompt suggestions: {MODE_LABELS[state.mode]}
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent
            align="start"
            side="top"
            mobileTitle="Prompt suggestions"
            className="w-48"
          >
            <DropdownMenuLabel>Next-prompt suggestions</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {(["automatic", "button", "off"] as const).map((mode) => (
              <DropdownMenuCheckboxItem
                key={mode}
                checked={state.mode === mode}
                onSelect={() => void configure(mode)}
              >
                {MODE_LABELS[mode]}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {state.mode === "button" && empty && !suggestion ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled || configuring || !state.sourceTurnId}
            onClick={() => (pending ? dismiss() : void request())}
            aria-label={
              pending
                ? "Cancel prompt suggestion"
                : "Generate next-prompt suggestion"
            }
          >
            {pending ? "Cancel" : "Suggest"}
          </Button>
        ) : null}
        {suggestion ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void accept()}
              aria-label="Accept suggested prompt"
            >
              Use
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onMouseDown={(event) => event.preventDefault()}
              onClick={dismiss}
              aria-label="Dismiss suggested prompt"
              className={COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS}
            >
              <Icon name="X" className="size-3.5" />
            </Button>
          </>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
