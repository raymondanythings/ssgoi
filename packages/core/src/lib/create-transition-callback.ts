import type { Transition, TransitionCallback, SequenceConfig } from "./types";
import { Animator } from "./animator";
import {
  createDefaultStrategy,
  type StrategyContext,
  type TransitionStrategy,
  type TransitionConfigs,
} from "./transition-strategy";

type TimeoutHandle = ReturnType<typeof setTimeout>;

interface SequenceChildEntry {
  callback: TransitionCallback;
  cleanup?: () => void;
  pendingTimers: Set<TimeoutHandle>;
  notifyCleanup?: () => void;
}

let sequenceInstanceCounter = 0;
const SEQUENCE_CHILD_KEY_ATTR = "data-ssgoi-sequence-key";

export function createTransitionCallback<TAnimationValue = number>(
  getTransition: () => Transition<undefined, TAnimationValue>,
  options?: {
    onCleanupEnd?: () => void;
    strategy?: (
      context: StrategyContext<TAnimationValue>,
    ) => TransitionStrategy<TAnimationValue>;
    sequenceConfig?: SequenceConfig;
    baseKey?: string | symbol;
  },
): TransitionCallback {
  const sequenceEntries = new Map<string, SequenceChildEntry>();
  const sequenceInstanceId = `seq-${++sequenceInstanceCounter}`;
  let activeCleanup: (() => void) | undefined;
  let currentElement: HTMLElement | null = null;

  // Combined state: tracks both animation instance and direction
  let currentAnimation: {
    animator: Animator<TAnimationValue>;
    direction: "in" | "out";
  } | null = null;
  let currentClone: HTMLElement | null = null; // Track current clone element
  let parentRef: Element | null = null;
  let nextSiblingRef: Element | null = null;

  // Create context for strategy
  const context: StrategyContext<TAnimationValue> = {
    get currentAnimation() {
      return currentAnimation;
    },
  };

  // Create strategy upfront for closure
  const strategy =
    options?.strategy?.(context) ||
    createDefaultStrategy<TAnimationValue>(context);

  const runEntrance = async (element: HTMLElement) => {
    if (currentClone) {
      currentClone.remove();
      currentClone = null;
    }
    const transition = getTransition();
    const configs: TransitionConfigs<TAnimationValue> = {
      in: transition.in && Promise.resolve(transition.in(element)),
      out: transition.out && Promise.resolve(transition.out(element)),
    };

    const setup = await strategy.runIn(configs);
    if (!setup.config) {
      return;
    }

    setup.config.prepare?.(element);

    // Wait if configured
    if (setup.config.wait) {
      await setup.config.wait();
    }

    const animator = Animator.fromState(setup.state, {
      from: setup.from,
      to: setup.to,
      spring: setup.config.spring,
      onStart: setup.config.onStart,
      onUpdate: setup.config.tick,
      onComplete: () => {
        currentAnimation = null;
        setup.config?.onEnd?.();
      },
    });

    currentAnimation = { animator, direction: "in" };

    if (setup.direction === "forward") {
      animator.forward();
    } else {
      animator.backward();
    }
  };

  const runExitTransition = async (element: HTMLElement) => {
    currentClone = element;

    const transition = getTransition();

    const configs: TransitionConfigs<TAnimationValue> = {
      in: transition.in && Promise.resolve(transition.in(element)),
      out: transition.out && Promise.resolve(transition.out(element)),
    };

    const setup = await strategy.runOut(configs);
    if (!setup.config) {
      return;
    }

    setup.config.prepare?.(element);

    insertClone();

    // Wait if configured
    if (setup.config.wait) {
      await setup.config.wait();
    }

    const animator = Animator.fromState(setup.state, {
      from: setup.from,
      to: setup.to,
      spring: setup.config.spring,
      onStart: setup.config.onStart,
      onUpdate: setup.config.tick,
      onComplete: () => {
        setup.config?.onEnd?.();
        if (currentClone) {
          currentClone.remove();
          currentClone = null;
        }
        currentAnimation = null;
        options?.onCleanupEnd?.();
      },
    });

    currentAnimation = { animator, direction: "out" };

    if (setup.direction === "forward") {
      animator.forward();
    } else {
      animator.backward();
    }

    function insertClone() {
      if (!parentRef || !currentClone) return;

      if (nextSiblingRef && parentRef.contains(nextSiblingRef)) {
        parentRef.insertBefore(currentClone, nextSiblingRef);
      } else {
        parentRef.appendChild(currentClone);
      }
    }
  };

  return (element: HTMLElement | null) => {
    if (!element) {
      if (activeCleanup) {
        activeCleanup();
        activeCleanup = undefined;
      }
      currentElement = null;
      return;
    }

    if (element === currentElement) {
      return;
    }

    if (activeCleanup) {
      activeCleanup();
      activeCleanup = undefined;
    }

    currentElement = element;

    // Handle sequence transitions
    if (options?.sequenceConfig) {
      const sequenceOptions =
        options.onCleanupEnd || options.strategy
          ? {
              onCleanupEnd: options.onCleanupEnd,
              strategy: options.strategy,
            }
          : undefined;
      activeCleanup = applySequenceTransition(
        element,
        getTransition,
        options.sequenceConfig,
        options.baseKey || "sequence",
        sequenceEntries,
        sequenceInstanceId,
        sequenceOptions,
      );
      return;
    }

    // Handle regular single-element transition
    parentRef = element.parentElement;
    nextSiblingRef = element.nextElementSibling;

    runEntrance(element);

    activeCleanup = () => {
      const cloned = element.cloneNode(true) as HTMLElement;
      runExitTransition(cloned);
    };
  };
}

/**
 * Calculate delay for sequence effect
 */
function calculateSequenceDelay(
  index: number,
  total: number,
  config: SequenceConfig,
): number {
  const baseDelay = config.delay || 50; // Default 50ms
  const direction = config.direction || "normal";

  if (config.delayFn) {
    return config.delayFn(index, total);
  }

  const actualIndex = direction === "reverse" ? total - 1 - index : index;
  return actualIndex * baseDelay;
}

/**
 * Apply sequence transition to child elements
 */
function applySequenceTransition<TAnimationValue>(
  parentElement: HTMLElement,
  getTransition: () => Transition<undefined, TAnimationValue>,
  sequenceConfig: SequenceConfig,
  baseKey: string | symbol,
  entries: Map<string, SequenceChildEntry>,
  instanceId: string,
  parentOptions?: {
    onCleanupEnd?: () => void;
    strategy?: (
      context: StrategyContext<TAnimationValue>,
    ) => TransitionStrategy<TAnimationValue>;
  },
): () => void {
  const children = Array.from(parentElement.children) as HTMLElement[];
  const total = children.length;

  const hostParent = parentElement.parentElement;
  const nextSibling = parentElement.nextElementSibling;
  const fallbackParent =
    hostParent?.parentElement ?? parentElement.parentElement;
  const fallbackSibling =
    hostParent?.nextElementSibling ?? parentElement.nextElementSibling;

  let insertionParent: Element | null = hostParent;
  let insertionSibling: Element | null = nextSibling;

  if (total === 0) {
    return () => {
      parentOptions?.onCleanupEnd?.();
    };
  }

  const baseKeyString =
    typeof baseKey === "symbol"
      ? (baseKey.description ?? String(baseKey))
      : String(baseKey);

  const records = children.map((child, index) => {
    const key = ensureSequenceChildKey(child, index, baseKeyString, instanceId);
    return { child, key, index };
  });

  records.forEach(({ child, key, index }) => {
    const entry = getOrCreateSequenceEntry(
      key,
      entries,
      getTransition,
      parentOptions,
    );
    clearPendingTimers(entry);
    const delay = calculateSequenceDelay(index, total, sequenceConfig);
    scheduleEntry(entry, delay, () => {
      entry.notifyCleanup = undefined;
      try {
        const cleanup = entry.callback(child);
        entry.cleanup = typeof cleanup === "function" ? cleanup : undefined;
      } catch (error) {
        console.error("⚠️ Sequence entrance error", error);
        entry.cleanup = undefined;
      }
    });
  });

  return () => {
    let remaining = records.length;

    ({ parent: insertionParent, sibling: insertionSibling } =
      ensureHostPlacement(
        parentElement,
        insertionParent,
        insertionSibling,
        fallbackParent,
        fallbackSibling,
      ));

    parentElement.replaceChildren();

    if (remaining === 0) {
      if (parentElement.isConnected) {
        parentElement.remove();
      }
      parentOptions?.onCleanupEnd?.();
      return;
    }

    const notifyParent = () => {
      remaining -= 1;
      if (remaining <= 0) {
        if (parentElement.isConnected) {
          parentElement.remove();
        }
        parentOptions?.onCleanupEnd?.();
      }
    };

    records.forEach(({ key, index }) => {
      const entry = entries.get(key);
      if (!entry) {
        notifyParent();
        return;
      }

      clearPendingTimers(entry);

      const delay = calculateSequenceDelay(
        index,
        records.length,
        sequenceConfig,
      );

      const runExit = () => {
        if (!entry.cleanup) {
          entries.delete(key);
          notifyParent();
          return;
        }

        entry.notifyCleanup = () => {
          entries.delete(key);
          notifyParent();
        };

        try {
          entry.cleanup();
        } catch (error) {
          console.error("⚠️ Sequence exit error", error);
          entry.cleanup = undefined;
          entry.notifyCleanup = undefined;
          entries.delete(key);
          notifyParent();
        }
      };

      scheduleEntry(entry, delay, runExit);
    });
  };
}

function ensureHostPlacement(
  host: HTMLElement,
  insertionParent: Element | null,
  insertionSibling: Element | null,
  fallbackParent: Element | null,
  fallbackSibling: Element | null,
): { parent: Element | null; sibling: Element | null } {
  let parentRef = insertionParent;
  let siblingRef = insertionSibling;

  if (!parentRef && fallbackParent) {
    parentRef = fallbackParent;
    siblingRef = fallbackSibling;
  }

  if (!parentRef) {
    if (fallbackParent) {
      fallbackParent.appendChild(host);
      parentRef = fallbackParent;
      siblingRef =
        fallbackSibling && fallbackParent.contains(fallbackSibling)
          ? fallbackSibling
          : null;
    }
    return { parent: parentRef, sibling: siblingRef };
  }

  if (siblingRef && !parentRef.contains(siblingRef)) {
    siblingRef = null;
  }

  if (siblingRef) {
    parentRef.insertBefore(host, siblingRef);
  } else {
    parentRef.appendChild(host);
  }

  return { parent: parentRef, sibling: siblingRef };
}

function ensureSequenceChildKey(
  child: HTMLElement,
  index: number,
  baseKey: string,
  instanceId: string,
): string {
  const existing = child.getAttribute(SEQUENCE_CHILD_KEY_ATTR);
  if (existing) {
    return existing;
  }

  const generated = `${instanceId}:${baseKey}:${index}`;
  child.setAttribute(SEQUENCE_CHILD_KEY_ATTR, generated);
  return generated;
}

function getOrCreateSequenceEntry<TAnimationValue>(
  key: string,
  entries: Map<string, SequenceChildEntry>,
  getTransition: () => Transition<undefined, TAnimationValue>,
  parentOptions?: {
    strategy?: (
      context: StrategyContext<TAnimationValue>,
    ) => TransitionStrategy<TAnimationValue>;
  },
): SequenceChildEntry {
  const existing = entries.get(key);
  if (existing) {
    return existing;
  }

  const entry: SequenceChildEntry = {
    callback: (() => undefined) as TransitionCallback,
    pendingTimers: new Set<TimeoutHandle>(),
  };

  entry.callback = createTransitionCallback<TAnimationValue>(getTransition, {
    strategy: parentOptions?.strategy,
    onCleanupEnd: () => {
      entry.cleanup = undefined;
      const notify = entry.notifyCleanup;
      entry.notifyCleanup = undefined;
      notify?.();
    },
  });

  entries.set(key, entry);
  return entry;
}

function scheduleEntry(
  entry: SequenceChildEntry,
  delay: number,
  task: () => void,
): void {
  if (delay > 0) {
    const timerId = setTimeout(() => {
      entry.pendingTimers.delete(timerId);
      task();
    }, delay);
    entry.pendingTimers.add(timerId);
    return;
  }

  task();
}

function clearPendingTimers(entry: SequenceChildEntry): void {
  entry.pendingTimers.forEach((timerId) => {
    clearTimeout(timerId);
  });
  entry.pendingTimers.clear();
}
