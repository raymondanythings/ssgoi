import { Animator } from "./animator";
import {
  createDefaultStrategy,
  type StrategyContext,
  type TransitionConfigs,
  type TransitionStrategy,
} from "./transition-strategy";
import type {
  SequenceConfig,
  Transition,
  TransitionCallback,
  TransitionConfig,
} from "./types";

const clampProgress = (value: number): number =>
  Math.min(1, Math.max(0, value));

type SequenceExitController = {
  cancelAndGetProgress: () => Map<number, number>;
};

const activeSequenceExits = new Map<string | symbol, SequenceExitController>();

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
    if (!element) return;

    // Handle sequence transitions
    if (options?.sequenceConfig) {
      return applySequenceTransition(
        element,
        getTransition,
        options.sequenceConfig,
        options.baseKey || "sequence",
        options,
      );
    }

    // Handle regular single-element transition
    parentRef = element.parentElement;
    nextSiblingRef = element.nextElementSibling;

    runEntrance(element);

    return () => {
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
  parentOptions?: {
    onCleanupEnd?: () => void;
    strategy?: (
      context: StrategyContext<TAnimationValue>,
    ) => TransitionStrategy<TAnimationValue>;
  },
): () => void {
  const children = Array.from(parentElement.children) as HTMLElement[];
  const hostParent = parentElement.parentElement;
  const nextSibling = parentElement.nextElementSibling;

  const resolveTransitionConfig = async (
    configSource:
      | Transition<undefined, TAnimationValue>["in"]
      | Transition<undefined, TAnimationValue>["out"],
    node: HTMLElement,
  ): Promise<TransitionConfig<TAnimationValue> | undefined> => {
    if (!configSource) return undefined;
    const value =
      typeof configSource === "function" ? configSource(node) : configSource;
    if (value && typeof value === "object" && "then" in value) {
      return (await value) as TransitionConfig<TAnimationValue>;
    }
    return value as TransitionConfig<TAnimationValue>;
  };

  type PlaybackOptions = {
    initialProgress?: number;
    targetProgress?: number;
    skipPrepare?: boolean;
    skipWait?: boolean;
    suppressOnStart?: boolean;
    onProgress?: (value: number) => void;
  };

  type PlaybackHandle = {
    promise: Promise<void>;
    cancel: () => void;
    getProgress: () => number;
  };

  const playTransition = (
    node: HTMLElement,
    config: TransitionConfig<TAnimationValue>,
    direction: "in" | "out",
    options?: PlaybackOptions,
  ): PlaybackHandle => {
    if (!options?.skipPrepare) {
      config.prepare?.(node);
    }

    let resolvePromise!: () => void;
    let isResolved = false;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });

    const defaultStart = direction === "in" ? 0 : 1;
    const defaultTarget = direction === "in" ? 1 : 0;
    const startValue =
      options?.initialProgress !== undefined
        ? options.initialProgress
        : defaultStart;
    const targetValue =
      options?.targetProgress !== undefined
        ? options.targetProgress
        : defaultTarget;

    let lastProgress = startValue;
    options?.onProgress?.(startValue);
    let isCancelled = false;
    let animationFrame: number | null = null;

    const cleanup = (shouldCallEnd: boolean) => {
      if (isResolved) {
        return;
      }

      if (animationFrame !== null) {
        cancelAnimationFrame(animationFrame);
        animationFrame = null;
      }

      if (shouldCallEnd) {
        config.onEnd?.();
      }

      options?.onProgress?.(lastProgress);
      isResolved = true;
      resolvePromise();
    };

    const cancel = () => {
      if (isCancelled) {
        return;
      }
      isCancelled = true;
      cleanup(false);
    };

    const run = async () => {
      if (isCancelled) {
        cleanup(false);
        return;
      }

      if (!options?.skipWait && config.wait) {
        try {
          await config.wait();
        } catch (error) {
          console.error("⚠️ Sequence wait error", error);
        }

        if (isCancelled) {
          cleanup(false);
          return;
        }
      }

      if (!options?.suppressOnStart) {
        config.onStart?.();
      }

      if (config.tick && config.spring) {
        const duration = 500;
        const startTime = performance.now();

        const animate = (currentTime: number) => {
          if (isCancelled) {
            cleanup(false);
            return;
          }

          const elapsed = currentTime - startTime;
          const progress = Math.min(elapsed / duration, 1);
          const easedProgress = 1 - (1 - progress) ** 3;
          const value = startValue + (targetValue - startValue) * easedProgress;

          lastProgress = value;
          config.tick?.(value as TAnimationValue);
          options?.onProgress?.(value);

          if (progress < 1) {
            animationFrame = requestAnimationFrame(animate);
          } else {
            cleanup(true);
          }
        };

        animationFrame = requestAnimationFrame(animate);
      } else {
        lastProgress = targetValue;
        options?.onProgress?.(targetValue);
        cleanup(true);
      }
    };

    run();

    return {
      promise,
      cancel,
      getProgress: () => lastProgress,
    };
  };

  type SequenceChildState = {
    timeoutId?: ReturnType<typeof setTimeout>;
    animation?: PlaybackHandle;
  };

  const childStates = new Map<number, SequenceChildState>();
  const previousExit = activeSequenceExits.get(baseKey);
  const childProgressOnForward = new Map<number, number>();

  if (previousExit) {
    const progressMap = previousExit.cancelAndGetProgress();
    progressMap.forEach((value, index) => {
      childProgressOnForward.set(index, clampProgress(value));
    });
  }

  let activeExit: {
    cancel: () => void;
    collectProgress: () => Map<number, number>;
  } | null = null;

  children.forEach((child, index) => {
    const delay = calculateSequenceDelay(
      index,
      children.length,
      sequenceConfig,
    );

    const state: SequenceChildState = {};
    childStates.set(index, state);

    // Apply entrance transition with delay
    const startEntrance = async () => {
      try {
        state.timeoutId = undefined;
        const transition = getTransition();
        const config = await resolveTransitionConfig(transition.in, child);
        if (!config) {
          childStates.delete(index);
          return;
        }

        const restoredProgress = childProgressOnForward.get(index);
        const hasStoredProgress =
          restoredProgress !== undefined &&
          restoredProgress > 0 &&
          restoredProgress < 1;

        const playback = playTransition(child, config, "in", {
          initialProgress: restoredProgress,
          suppressOnStart: hasStoredProgress,
          skipPrepare: hasStoredProgress,
          skipWait: hasStoredProgress,
        });
        state.animation = playback;

        await playback.promise;
      } catch (error) {
        console.error("⚠️ Sequence entrance error", error);
      } finally {
        const currentState = childStates.get(index);
        if (currentState === state) {
          state.animation = undefined;
          childStates.delete(index);
        }
      }
    };

    if (delay > 0) {
      state.timeoutId = setTimeout(() => {
        startEntrance();
      }, delay);
    } else {
      startEntrance();
    }
  });

  // Return cleanup function that handles sequence exit animation
  return () => {
    const exitPromises: Promise<void>[] = [];
    const cancelHandlers: (() => void)[] = [];
    let exitCancelled = false;
    const progressSnapshot = new Map<number, number>();

    const clone = parentElement.cloneNode(true) as HTMLElement;
    const hasHostParent = !!hostParent;

    let insertionParent: Element | null = hostParent;
    let insertionSibling: Element | null = nextSibling;

    const fallbackParent =
      hostParent?.parentElement ?? parentElement.parentElement;
    const fallbackSibling =
      hostParent?.nextElementSibling ?? parentElement.nextElementSibling;

    const ensureClonePlacement = () => {
      if (!insertionParent && fallbackParent) {
        insertionParent = fallbackParent;
        insertionSibling = fallbackSibling;
      }

      if (insertionParent) {
        if (insertionSibling && insertionParent.contains(insertionSibling)) {
          insertionParent.insertBefore(clone, insertionSibling);
        } else {
          insertionParent.appendChild(clone);
        }
      } else if (fallbackParent) {
        fallbackParent.appendChild(clone);
      }
    };

    ensureClonePlacement();

    const keepCloneConnected = () => {
      if (!clone.isConnected && fallbackParent) {
        if (fallbackSibling && fallbackParent.contains(fallbackSibling)) {
          fallbackParent.insertBefore(clone, fallbackSibling);
        } else {
          fallbackParent.appendChild(clone);
        }
      }
    };

    requestAnimationFrame(() => keepCloneConnected());

    const targetChildren = hasHostParent
      ? (Array.from(clone.children) as HTMLElement[])
      : children;

    const totalChildren = targetChildren.length;
    const getEntranceOrderIndex = (index: number) =>
      sequenceConfig.direction === "reverse"
        ? totalChildren - 1 - index
        : index;

    const exitSequenceConfig: SequenceConfig = {
      ...sequenceConfig,
      direction: "normal",
    };

    targetChildren.forEach((child, index) => {
      const exitOrderIndex = totalChildren
        ? totalChildren - 1 - getEntranceOrderIndex(index)
        : index;

      const delay = calculateSequenceDelay(
        exitOrderIndex,
        totalChildren,
        exitSequenceConfig,
      );

      const exitPromise = new Promise<void>((resolve) => {
        let finished = false;
        let playbackHandle: PlaybackHandle | null = null;
        let exitStartProgress: number | undefined;

        const finalizeProgress = () => {
          if (playbackHandle) {
            progressSnapshot.set(
              index,
              clampProgress(playbackHandle.getProgress()),
            );
          } else if (exitStartProgress !== undefined) {
            progressSnapshot.set(index, clampProgress(exitStartProgress));
          } else {
            progressSnapshot.set(index, 1);
          }
        };

        const finish = () => {
          if (finished) return;
          finished = true;
          finalizeProgress();
          resolve();
        };

        const startExit = async () => {
          try {
            const state = childStates.get(index);

            if (state?.timeoutId) {
              clearTimeout(state.timeoutId);
            }

            let progress: number | undefined;
            if (state?.animation) {
              const handle = state.animation;
              progress = handle.getProgress();
              handle.cancel();
            }

            childStates.delete(index);

            const transition = getTransition();
            const hasOutConfig = !!transition.out;
            const hasInConfig = !!transition.in;
            const normalizedProgress =
              typeof progress === "number"
                ? clampProgress(progress)
                : undefined;

            exitStartProgress = normalizedProgress ?? 1;

            if (exitCancelled) {
              finish();
              return;
            }

            const shouldReverseUsingIn =
              hasInConfig &&
              normalizedProgress !== undefined &&
              normalizedProgress > 0 &&
              normalizedProgress < 1;

            let configDirection: "in" | "out" = "out";
            let configSource:
              | Transition<undefined, TAnimationValue>["in"]
              | Transition<undefined, TAnimationValue>["out"]
              | undefined = transition.out;
            let playbackOptions: PlaybackOptions | undefined;

            if (shouldReverseUsingIn) {
              configDirection = "in";
              configSource = transition.in;
              playbackOptions = {
                initialProgress: normalizedProgress,
                targetProgress: 0,
                skipPrepare: true,
                skipWait: true,
                suppressOnStart: true,
              };
            } else if (!hasOutConfig && hasInConfig) {
              configDirection = "in";
              configSource = transition.in;
              playbackOptions = {
                initialProgress: normalizedProgress ?? 1,
                targetProgress: 0,
                skipPrepare: true,
                skipWait: true,
                suppressOnStart: true,
              };
            }

            if (!configSource) {
              finish();
              return;
            }

            const config = await resolveTransitionConfig(configSource, child);

            if (!config) {
              finish();
              return;
            }

            if (exitCancelled) {
              finish();
              return;
            }

            playbackHandle = playTransition(child, config, configDirection, {
              ...playbackOptions,
              onProgress: (value) => {
                progressSnapshot.set(index, clampProgress(value));
              },
            });

            cancelHandlers.push(() => {
              playbackHandle?.cancel();
              finish();
            });

            await playbackHandle.promise;
            finish();
          } catch (error) {
            console.error("⚠️ Sequence exit error", error);
            finish();
          }
        };

        if (delay > 0) {
          const timeoutId = setTimeout(() => {
            if (exitCancelled) {
              finish();
              return;
            }
            startExit();
          }, delay);
          cancelHandlers.push(() => {
            clearTimeout(timeoutId);
            finish();
          });
        } else {
          if (exitCancelled) {
            finish();
          } else {
            startExit();
          }
        }
      });

      exitPromises.push(exitPromise);
    });

    const cleanup = (shouldNotify = true) => {
      if (clone.isConnected) {
        clone.remove();
      }
      if (shouldNotify) {
        parentOptions?.onCleanupEnd?.();
      }
      activeExit = null;
      activeSequenceExits.delete(baseKey);
    };

    activeExit = {
      cancel: () => {
        if (exitCancelled) {
          return;
        }
        exitCancelled = true;
        cancelHandlers.forEach((handler) => handler());
        cancelHandlers.length = 0;
        cleanup(false);
      },
      collectProgress: () => new Map(progressSnapshot),
    };

    activeSequenceExits.set(baseKey, {
      cancelAndGetProgress: () => {
        if (activeExit) {
          const exitRef = activeExit;
          exitRef.cancel();
          return exitRef.collectProgress();
        }
        return new Map();
      },
    });

    Promise.all(exitPromises)
      .catch((error) => {
        console.error("⚠️ Sequence exit coordination error", error);
      })
      .finally(() => {
        if (!exitCancelled) {
          cleanup();
        }
      });
  };
}
