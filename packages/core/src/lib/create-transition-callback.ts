import type { Transition, TransitionCallback, SequenceConfig } from "./types";
import { Animator } from "./animator";
import {
  createDefaultStrategy,
  type StrategyContext,
  type TransitionStrategy,
  type TransitionConfigs,
} from "./transition-strategy";

type TimeoutHandle = ReturnType<typeof setTimeout>;

type Placement = {
  parent: Element | null;
  sibling: Element | null;
  fallbackParent: Element | null;
  fallbackSibling: Element | null;
};

type DetachOptions = {
  notifyWhenIdle?: boolean;
};

interface TransitionController {
  attach(element: HTMLElement): () => void;
  detach(options?: DetachOptions): void;
}

interface SequenceChildEntry {
  callback: TransitionCallback;
  cleanup?: () => void;
  pendingTimers: Set<TimeoutHandle>;
  notifyCleanup?: () => void;
}

let sequenceInstanceCounter = 0;
const SEQUENCE_CHILD_KEY_ATTR = "data-ssgoi-sequence-key";

class ElementTransitionController<TAnimationValue>
  implements TransitionController
{
  private currentAnimation: {
    animator: Animator<TAnimationValue>;
    direction: "in" | "out";
  } | null = null;
  private currentClone: HTMLElement | null = null;
  private activeCleanup: (() => void) | null = null;
  private readonly context: StrategyContext<TAnimationValue>;
  private readonly strategy: TransitionStrategy<TAnimationValue>;

  constructor(
    private readonly getTransition: () => Transition<
      undefined,
      TAnimationValue
    >,
    private readonly options: {
      onCleanupEnd?: () => void;
      strategyFactory?: (
        context: StrategyContext<TAnimationValue>,
      ) => TransitionStrategy<TAnimationValue>;
    } = {},
  ) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.context = {
      get currentAnimation() {
        return self.currentAnimation;
      },
    };

    this.strategy =
      this.options.strategyFactory?.(this.context) ??
      createDefaultStrategy<TAnimationValue>(this.context);
  }

  attach(element: HTMLElement): () => void {
    this.invokeActiveCleanup();

    void this.runEntrance(element).catch((error) => {
      console.error("⚠️ Transition entrance failed", error);
    });

    const placement: Placement = {
      parent: element.parentElement,
      sibling: element.nextElementSibling,
      fallbackParent: element.parentElement?.parentElement ?? null,
      fallbackSibling: element.parentElement?.nextElementSibling ?? null,
    };

    this.activeCleanup = () => {
      const cloned = element.cloneNode(true) as HTMLElement;
      void this.runExitTransition(cloned, placement).catch((error) => {
        console.error("⚠️ Transition exit failed", error);
        this.options.onCleanupEnd?.();
      });
    };

    return () => {
      this.detach();
    };
  }

  detach(options: DetachOptions = {}): void {
    const { notifyWhenIdle = true } = options;
    const cleanupInvoked = this.invokeActiveCleanup();
    if (!cleanupInvoked && notifyWhenIdle) {
      this.options.onCleanupEnd?.();
    }
  }

  private invokeActiveCleanup(): boolean {
    if (!this.activeCleanup) {
      return false;
    }

    const cleanup = this.activeCleanup;
    this.activeCleanup = null;

    try {
      cleanup();
    } catch (error) {
      console.error("⚠️ Transition cleanup failed", error);
      this.options.onCleanupEnd?.();
    }

    return true;
  }

  private async runEntrance(element: HTMLElement): Promise<void> {
    if (this.currentClone) {
      this.currentClone.remove();
      this.currentClone = null;
    }

    const transition = this.getTransition();
    const configs: TransitionConfigs<TAnimationValue> = {
      in: transition.in && Promise.resolve(transition.in(element)),
      out: transition.out && Promise.resolve(transition.out(element)),
    };

    const setup = await this.strategy.runIn(configs);
    if (!setup.config) {
      return;
    }

    setup.config.prepare?.(element);

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
        this.currentAnimation = null;
        setup.config?.onEnd?.();
      },
    });

    this.currentAnimation = { animator, direction: "in" };

    if (setup.direction === "forward") {
      animator.forward();
    } else {
      animator.backward();
    }
  }

  private async runExitTransition(
    element: HTMLElement,
    placement: Placement,
  ): Promise<void> {
    this.currentClone = element;

    const transition = this.getTransition();
    const configs: TransitionConfigs<TAnimationValue> = {
      in: transition.in && Promise.resolve(transition.in(element)),
      out: transition.out && Promise.resolve(transition.out(element)),
    };

    const setup = await this.strategy.runOut(configs);
    if (!setup.config) {
      this.options.onCleanupEnd?.();
      return;
    }

    setup.config.prepare?.(element);
    this.insertClone(element, placement);

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
        if (this.currentClone) {
          this.currentClone.remove();
          this.currentClone = null;
        }
        this.currentAnimation = null;
        this.options.onCleanupEnd?.();
      },
    });

    this.currentAnimation = { animator, direction: "out" };

    if (setup.direction === "forward") {
      animator.forward();
    } else {
      animator.backward();
    }
  }

  private insertClone(element: HTMLElement, placement: Placement): void {
    this.currentClone = element;

    const { parent, sibling, fallbackParent, fallbackSibling } = placement;

    if (parent && parent.isConnected) {
      if (sibling && parent.contains(sibling)) {
        parent.insertBefore(element, sibling);
      } else {
        parent.appendChild(element);
      }
      return;
    }

    if (fallbackParent && fallbackParent.isConnected) {
      if (fallbackSibling && fallbackParent.contains(fallbackSibling)) {
        fallbackParent.insertBefore(element, fallbackSibling);
      } else {
        fallbackParent.appendChild(element);
      }
    }
  }
}

class SequenceTransitionController<TAnimationValue>
  implements TransitionController
{
  private readonly entries = new Map<string, SequenceChildEntry>();
  private readonly instanceId = `seq-${++sequenceInstanceCounter}`;
  private activeCleanup: (() => void) | null = null;

  constructor(
    private readonly getTransition: () => Transition<
      undefined,
      TAnimationValue
    >,
    private readonly sequenceConfig: SequenceConfig,
    private readonly options: {
      baseKey?: string | symbol;
      onCleanupEnd?: () => void;
      strategyFactory?: (
        context: StrategyContext<TAnimationValue>,
      ) => TransitionStrategy<TAnimationValue>;
    } = {},
  ) {}

  attach(element: HTMLElement): () => void {
    this.detach({ notifyWhenIdle: false });

    this.activeCleanup = this.applySequenceTransition(element);

    return () => {
      this.detach();
    };
  }

  detach(options: DetachOptions = {}): void {
    const { notifyWhenIdle = true } = options;
    const cleanupInvoked = this.invokeActiveCleanup();
    if (!cleanupInvoked && notifyWhenIdle) {
      this.options.onCleanupEnd?.();
    }
  }

  private invokeActiveCleanup(): boolean {
    if (!this.activeCleanup) {
      return false;
    }

    const cleanup = this.activeCleanup;
    this.activeCleanup = null;

    try {
      cleanup();
    } catch (error) {
      console.error("⚠️ Sequence transition cleanup failed", error);
      this.options.onCleanupEnd?.();
    }

    return true;
  }

  private applySequenceTransition(element: HTMLElement): () => void {
    const children = Array.from(element.children) as HTMLElement[];
    const total = children.length;

    if (total === 0) {
      return () => {
        this.options.onCleanupEnd?.();
      };
    }

    const baseKeyValue = this.options.baseKey ?? "sequence";
    const baseKeyString =
      typeof baseKeyValue === "symbol"
        ? (baseKeyValue.description ?? String(baseKeyValue))
        : String(baseKeyValue);

    const records = children.map((child, index) => {
      const key = ensureSequenceChildKey(
        child,
        index,
        baseKeyString,
        this.instanceId,
      );
      return { child, key, index };
    });

    records.forEach(({ child, key, index }) => {
      const entry = this.getOrCreateSequenceEntry(key);
      clearPendingTimers(entry);
      const delay = calculateSequenceDelay(index, total, this.sequenceConfig);
      scheduleEntry(entry, delay, () => {
        entry.notifyCleanup = undefined;
        try {
          const cleanupResult = entry.callback(child);
          entry.cleanup =
            typeof cleanupResult === "function"
              ? cleanupResult
              : () => {
                  entry.callback(null);
                };
        } catch (error) {
          console.error("⚠️ Sequence entrance error", error);
          entry.cleanup = undefined;
        }
      });
    });

    return () => {
      const exitPromises = records.map(({ key, index }) => {
        const entry = this.entries.get(key);
        if (!entry) {
          return Promise.resolve();
        }

        clearPendingTimers(entry);

        return new Promise<void>((resolve) => {
          const delay = calculateSequenceDelay(
            index,
            records.length,
            this.sequenceConfig,
          );

          const triggerExit = () => {
            const cleanupFn = entry.cleanup;

            if (!cleanupFn) {
              this.entries.delete(key);
              resolve();
              return;
            }

            entry.notifyCleanup = () => {
              entry.notifyCleanup = undefined;
              entry.cleanup = undefined;
              this.entries.delete(key);
              resolve();
            };

            try {
              entry.cleanup = undefined;
              cleanupFn();
            } catch (error) {
              console.error("⚠️ Sequence exit error", error);
              entry.notifyCleanup = undefined;
              this.entries.delete(key);
              resolve();
            }
          };

          scheduleEntry(entry, delay, triggerExit);
        });
      });

      void Promise.all(exitPromises)
        .catch((error) => {
          console.error("⚠️ Sequence exit coordination error", error);
        })
        .finally(() => {
          this.options.onCleanupEnd?.();
        });
    };
  }

  private getOrCreateSequenceEntry(key: string): SequenceChildEntry {
    const existing = this.entries.get(key);
    if (existing) {
      return existing;
    }

    const entry: SequenceChildEntry = {
      callback: (() => undefined) as TransitionCallback,
      pendingTimers: new Set<TimeoutHandle>(),
    };

    entry.callback = createTransitionCallback<TAnimationValue>(
      this.getTransition,
      {
        strategy: this.options.strategyFactory,
        onCleanupEnd: () => {
          entry.cleanup = undefined;
          const notify = entry.notifyCleanup;
          entry.notifyCleanup = undefined;
          notify?.();
        },
      },
    );

    this.entries.set(key, entry);
    return entry;
  }
}

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
  const controller: TransitionController = options?.sequenceConfig
    ? new SequenceTransitionController<TAnimationValue>(
        getTransition,
        options.sequenceConfig,
        {
          baseKey: options.baseKey,
          onCleanupEnd: options.onCleanupEnd,
          strategyFactory: options.strategy,
        },
      )
    : new ElementTransitionController<TAnimationValue>(getTransition, {
        onCleanupEnd: options?.onCleanupEnd,
        strategyFactory: options?.strategy,
      });

  let currentElement: HTMLElement | null = null;

  return (element: HTMLElement | null) => {
    if (!element) {
      currentElement = null;
      controller.detach();
      return;
    }

    if (element === currentElement) {
      return;
    }

    if (currentElement) {
      controller.detach({ notifyWhenIdle: false });
    }

    currentElement = element;
    return controller.attach(element);
  };
}

function calculateSequenceDelay(
  index: number,
  total: number,
  config: SequenceConfig,
): number {
  const baseDelay = config.delay || 50;
  const direction = config.direction || "normal";

  if (config.delayFn) {
    return config.delayFn(index, total);
  }

  const actualIndex = direction === "reverse" ? total - 1 - index : index;
  return actualIndex * baseDelay;
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
