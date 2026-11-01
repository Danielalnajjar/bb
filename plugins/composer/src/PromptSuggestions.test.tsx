// @vitest-environment jsdom
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useComposer } from "@get-bb/plugin-sdk/app";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import {
  PromptSuggestionControls,
  useComposerPromptSuggestion,
} from "./PromptSuggestions";

type State = NonNullable<
  ReturnType<typeof useComposerPromptSuggestion>["state"]
>;

afterEach(cleanup);

function Fixture() {
  const composer = useComposer();
  const controller = useComposerPromptSuggestion({
    composer,
    blocked: false,
    hidden: false,
  });
  return (
    <>
      <textarea
        aria-label="Draft"
        value={composer.text}
        onChange={(event) =>
          composer.replace({ text: event.target.value, mentions: [] })
        }
        onKeyDown={(event) => controller.handleKey(event.nativeEvent)}
      />
      {controller.suggestion ? <p>{controller.suggestion.text}</p> : null}
      {controller.error ? <p role="status">{controller.error}</p> : null}
      <PromptSuggestionControls
        controller={controller}
        disabled={false}
        empty={composer.isEmpty}
      />
    </>
  );
}

function pendingResponse() {
  let resolve: (value: State) => void = () => {
    throw new Error("Response not initialized");
  };
  let reject: (cause: Error) => void = () => {
    throw new Error("Response not initialized");
  };
  const promise = new Promise<State>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function suggestionState(): State {
  return {
    mode: "button",
    modeOverride: null,
    eligible: true,
    sourceTurnId: "completed-source",
    text: "Add the keyboard navigation",
    pending: false,
  };
}

it("accepts into an editable draft without sending a message", async () => {
  const state = suggestionState();
  const slot = renderSlot(
    { component: Fixture },
    {},
    {
      composer: { scope: { kind: "thread", threadId: "owner" } },
      promptSuggestions: state,
      sdk: {
        threads: {
          experimental_promptSuggestions: {
            get: async () => state,
            dismiss: async () => ({ ...state, text: null }),
          },
        },
      },
    },
  );

  expect(slot.inspection.composer.text).toBe("");
  expect(slot.getByText(state.text!)).toBeTruthy();
  await act(async () => {
    fireEvent.click(
      slot.getByRole("button", { name: "Accept suggested prompt" }),
    );
  });
  expect(slot.inspection.composer.text).toBe(state.text);
  expect(slot.inspection.composer.submits).toEqual([]);

  fireEvent.change(slot.getByRole("textbox", { name: "Draft" }), {
    target: { value: "Edit the keyboard behavior first" },
  });
  expect(slot.inspection.composer.text).toBe(
    "Edit the keyboard behavior first",
  );
  expect(slot.inspection.composer.submits).toEqual([]);
});

it("does not overwrite a draft edited while acceptance is being checked", async () => {
  const state = suggestionState();
  const response = pendingResponse();
  const slot = renderSlot(
    { component: Fixture },
    {},
    {
      composer: { scope: { kind: "thread", threadId: "owner" } },
      promptSuggestions: state,
      sdk: {
        threads: {
          experimental_promptSuggestions: { get: () => response.promise },
        },
      },
    },
  );

  fireEvent.click(
    slot.getByRole("button", { name: "Accept suggested prompt" }),
  );
  await slot.behavior.setComposerText("My own next prompt");
  await act(async () => {
    response.resolve(state);
  });
  expect(
    slot.queryByRole("button", { name: "Accept suggested prompt" }),
  ).toBeNull();
  expect(slot.inspection.composer.text).toBe("My own next prompt");
  expect(slot.inspection.composer.submits).toEqual([]);
});

it("honors dismissal while an acceptance response is pending", async () => {
  const state = suggestionState();
  const response = pendingResponse();
  const slot = renderSlot(
    { component: Fixture },
    {},
    {
      composer: { scope: { kind: "thread", threadId: "owner" } },
      promptSuggestions: state,
      sdk: {
        threads: {
          experimental_promptSuggestions: {
            get: () => response.promise,
            dismiss: async () => ({ ...state, text: null }),
          },
        },
      },
    },
  );

  fireEvent.click(
    slot.getByRole("button", { name: "Accept suggested prompt" }),
  );
  fireEvent.keyDown(slot.getByRole("textbox", { name: "Draft" }), {
    key: "Escape",
  });
  await act(async () => {
    response.resolve(state);
  });
  expect(slot.queryByText(state.text!)).toBeNull();
  expect(slot.inspection.composer.text).toBe("");
  expect(slot.inspection.composer.submits).toEqual([]);
});

it("does not fill a draft edited and then cleared during acceptance", async () => {
  const state = suggestionState();
  const response = pendingResponse();
  const slot = renderSlot(
    { component: Fixture },
    {},
    {
      composer: { scope: { kind: "thread", threadId: "owner" } },
      promptSuggestions: state,
      sdk: {
        threads: {
          experimental_promptSuggestions: { get: () => response.promise },
        },
      },
    },
  );

  fireEvent.click(
    slot.getByRole("button", { name: "Accept suggested prompt" }),
  );
  await slot.behavior.setComposerText("Changed my mind");
  await slot.behavior.setComposerText("");
  await act(async () => {
    response.resolve(state);
  });
  expect(slot.inspection.composer.text).toBe("");
  expect(slot.inspection.composer.submits).toEqual([]);
});

it.each([
  { changed: "source", patch: { sourceTurnId: "new-source" } },
  { changed: "eligibility", patch: { eligible: false } },
  { changed: "mode", patch: { mode: "off" as const } },
])(
  "rejects acceptance when the server reports changed $changed",
  async ({ patch }) => {
    const state = suggestionState();
    const slot = renderSlot(
      { component: Fixture },
      {},
      {
        composer: { scope: { kind: "thread", threadId: "owner" } },
        promptSuggestions: state,
        sdk: {
          threads: {
            experimental_promptSuggestions: {
              get: async () => ({ ...state, ...patch }),
            },
          },
        },
      },
    );

    await act(async () => {
      fireEvent.click(
        slot.getByRole("button", { name: "Accept suggested prompt" }),
      );
    });

    expect(slot.inspection.composer.text).toBe("");
    expect(slot.inspection.composer.submits).toEqual([]);
  },
);

it("allows an explicit request in another thread while the first thread is still generating", async () => {
  const state = { ...suggestionState(), text: null };
  const first = pendingResponse();
  const second = pendingResponse();
  const requested: string[] = [];
  const slot = renderSlot(
    { component: Fixture },
    {},
    {
      composer: { scope: { kind: "thread", threadId: "first" } },
      promptSuggestions: state,
      sdk: {
        threads: {
          experimental_promptSuggestions: {
            request: ({ threadId }) => {
              requested.push(threadId);
              return threadId === "first" ? first.promise : second.promise;
            },
          },
        },
      },
    },
  );

  fireEvent.click(
    slot.getByRole("button", { name: "Generate next-prompt suggestion" }),
  );
  await slot.behavior.setComposerScope({
    kind: "thread",
    threadId: "second",
  });
  fireEvent.click(
    slot.getByRole("button", { name: "Generate next-prompt suggestion" }),
  );
  expect(requested).toEqual(["first", "second"]);
  await act(async () => {
    first.resolve(suggestionState());
    second.resolve(suggestionState());
  });
  expect(slot.inspection.composer.text).toBe("");
  expect(slot.inspection.composer.submits).toEqual([]);
});

it.each([
  { advanced: false, failure: true },
  { advanced: true, failure: true },
  { advanced: true, failure: false },
])(
  "scopes request feedback to its source: $advanced / $failure",
  async ({ advanced, failure }) => {
    const state = { ...suggestionState(), text: null };
    const response = pendingResponse();
    const slot = renderSlot(
      { component: Fixture },
      {},
      {
        composer: { scope: { kind: "thread", threadId: "owner" } },
        promptSuggestions: state,
        sdk: {
          threads: {
            experimental_promptSuggestions: { request: () => response.promise },
          },
        },
      },
    );
    fireEvent.click(
      slot.getByRole("button", { name: "Generate next-prompt suggestion" }),
    );
    if (advanced) {
      state.sourceTurnId = "new-source";
      slot.lifecycle.rerender(<Fixture />);
    }
    await act(async () => {
      if (failure) response.reject(new Error("sample canceled"));
      else response.resolve(state);
    });
    if (advanced) expect(slot.queryByRole("status")).toBeNull();
    else expect(slot.getByRole("status").textContent).toBe("sample canceled");
    expect(slot.inspection.composer.text).toBe("");
    expect(slot.inspection.composer.submits).toEqual([]);
  },
);
