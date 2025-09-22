import type { Transition, TransitionCallback, TransitionScope } from "./types";
import { Animator } from "./animator";
import {
  createDefaultStrategy,
  type StrategyContext,
  type TransitionStrategy,
  type TransitionConfigs,
} from "./transition-strategy";

type ActiveTransitionEntry = {
  scope: TransitionScope;
  depth: number;
};

const activeTransitions = new WeakMap<HTMLElement, ActiveTransitionEntry>();

function activateTransition(
  element: HTMLElement,
  scope: TransitionScope,
): () => void {
  const existing = activeTransitions.get(element);
  if (existing) {
    existing.depth += 1;
    return () => {
      existing.depth -= 1;
      if (existing.depth <= 0) {
        activeTransitions.delete(element);
      }
    };
  }

  const entry: ActiveTransitionEntry = { scope, depth: 1 };
  activeTransitions.set(element, entry);
  return () => {
    const current = activeTransitions.get(element);
    if (!current) {
      return;
    }
    current.depth -= 1;
    if (current.depth <= 0) {
      activeTransitions.delete(element);
    }
  };
}

function hasActiveAncestor(element: HTMLElement): boolean {
  let current = element.parentElement;
  while (current) {
    if (activeTransitions.has(current)) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function prepareScope(
  element: HTMLElement,
  scope: TransitionScope,
): { shouldAnimate: boolean; deactivate: () => void } {
  const shouldAnimate =
    scope === "global" || scope === "both" || hasActiveAncestor(element);

  if (!shouldAnimate) {
    return { shouldAnimate: false, deactivate: () => {} };
  }

  const deactivate = activateTransition(element, scope);
  return { shouldAnimate: true, deactivate };
}

export function createTransitionCallback<TAnimationValue = number>(
  getTransition: () => Transition<undefined, TAnimationValue>,
  options?: {
    onCleanupEnd?: () => void;
    strategy?: (
      context: StrategyContext<TAnimationValue>,
    ) => TransitionStrategy<TAnimationValue>;
    scope?: TransitionScope;
    scopeHooks?: {
      onActivate?: (direction: "in" | "out") => void;
      onDeactivate?: (direction: "in" | "out") => void;
    };
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

  const scope: TransitionScope = options?.scope ?? "global";

  // Create strategy upfront for closure
  const strategy =
    options?.strategy?.(context) ||
    createDefaultStrategy<TAnimationValue>(context);

  const runEntrance = async (element: HTMLElement) => {
    const scopeGuard = prepareScope(element, scope);
    if (!scopeGuard.shouldAnimate) {
      return;
    }

    options?.scopeHooks?.onActivate?.("in");
    let scopeActive = true;

    if (currentClone) {
      currentClone.remove();
      currentClone = null;
    }
    const transition = getTransition();
    const configs: TransitionConfigs<TAnimationValue> = {
      in: transition.in && Promise.resolve(transition.in(element)),
      out: transition.out && Promise.resolve(transition.out(element)),
    };

    let setup;
    try {
      setup = await strategy.runIn(configs);
    } catch (error) {
      if (scopeActive) {
        options?.scopeHooks?.onDeactivate?.("in");
        scopeActive = false;
      }
      scopeGuard.deactivate();
      throw error;
    }

    if (!setup.config) {
      if (scopeActive) {
        options?.scopeHooks?.onDeactivate?.("in");
        scopeActive = false;
      }
      scopeGuard.deactivate();
      return;
    }

    setup.config.prepare?.(element);

    // Wait if configured
    if (setup.config.wait) {
      try {
        await setup.config.wait();
      } catch (error) {
        if (scopeActive) {
          options?.scopeHooks?.onDeactivate?.("in");
          scopeActive = false;
        }
        scopeGuard.deactivate();
        throw error;
      }
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
        if (scopeActive) {
          options?.scopeHooks?.onDeactivate?.("in");
          scopeActive = false;
        }
        scopeGuard.deactivate();
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
    const scopeGuard = prepareScope(element, scope);
    if (!scopeGuard.shouldAnimate) {
      options?.onCleanupEnd?.();
      return;
    }

    options?.scopeHooks?.onActivate?.("out");
    let scopeActive = true;

    currentClone = element;

    const transition = getTransition();

    const configs: TransitionConfigs<TAnimationValue> = {
      in: transition.in && Promise.resolve(transition.in(element)),
      out: transition.out && Promise.resolve(transition.out(element)),
    };

    let setup;
    try {
      setup = await strategy.runOut(configs);
    } catch (error) {
      if (scopeActive) {
        options?.scopeHooks?.onDeactivate?.("out");
        scopeActive = false;
      }
      scopeGuard.deactivate();
      throw error;
    }

    if (!setup.config) {
      if (scopeActive) {
        options?.scopeHooks?.onDeactivate?.("out");
        scopeActive = false;
      }
      scopeGuard.deactivate();
      return;
    }

    setup.config.prepare?.(element);

    insertClone();

    // Wait if configured
    if (setup.config.wait) {
      try {
        await setup.config.wait();
      } catch (error) {
        if (scopeActive) {
          options?.scopeHooks?.onDeactivate?.("out");
          scopeActive = false;
        }
        scopeGuard.deactivate();
        throw error;
      }
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
        if (scopeActive) {
          options?.scopeHooks?.onDeactivate?.("out");
          scopeActive = false;
        }
        scopeGuard.deactivate();
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
    parentRef = element.parentElement;
    nextSiblingRef = element.nextElementSibling;

    runEntrance(element);

    return () => {
      const cloned = element.cloneNode(true) as HTMLElement;
      runExitTransition(cloned);
    };
  };
}
