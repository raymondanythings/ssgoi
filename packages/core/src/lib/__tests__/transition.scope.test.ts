import { beforeEach, describe, expect, it, vi } from "vitest";
import { transition, generateAutoKey } from "../transition";

describe("transition scope", () => {
  const fromStateMock = vi.hoisted(() =>
    vi.fn(
      (_state, options: { onStart?: () => void; onComplete?: () => void }) => {
        return {
          forward: () => {
            options.onStart?.();
          },
          backward: () => {
            options.onStart?.();
          },
        };
      },
    ),
  );
  vi.mock("../animator", async () => {
    const actual =
      await vi.importActual<typeof import("../animator")>("../animator");
    return {
      ...actual,
      Animator: {
        fromState: fromStateMock,
      },
    };
  });

  beforeEach(() => {
    fromStateMock.mockClear();
    document.body.innerHTML = "";
  });

  it("skips local transitions without active parent", () => {
    const element = document.createElement("div");
    document.body.appendChild(element);

    const localTransition = transition({
      scope: "local",
      in: () => ({ onStart: vi.fn() }),
    });

    localTransition(element);

    expect(fromStateMock).not.toHaveBeenCalled();
  });

  it("runs local transitions when parent is active", async () => {
    const parent = document.createElement("div");
    const child = document.createElement("div");
    parent.appendChild(child);
    document.body.appendChild(parent);

    const parentTransition = transition({
      key: "parent",
      scope: "global",
      in: () => ({ onStart: vi.fn() }),
    });

    const childTransition = transition({
      key: "child",
      scope: "local",
      in: () => ({ onStart: vi.fn() }),
    });

    parentTransition(parent);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const callsAfterParent = fromStateMock.mock.calls.length;

    childTransition(child);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fromStateMock.mock.calls.length).toBeGreaterThan(callsAfterParent);
  });

  it("generates unique auto keys for repeated call sites", () => {
    const keys = Array.from({ length: 3 }, () => generateAutoKey());
    const uniqueKeys = new Set(keys.map((key) => key.toString()));
    expect(uniqueKeys.size).toBe(keys.length);
  });
});
