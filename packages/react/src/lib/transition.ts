"use client";

import { useMemo, useRef } from "react";
import {
  TRANSITION_SCOPE_HOOKS,
  type TransitionCallback,
  type TransitionOptions,
  transition as coreTransition,
} from "@ssgoi/core";
import type { TransitionScope, TransitionScopeHooks } from "@ssgoi/core/types";
import { useTransitionScopeContext } from "./scope-context";

export const transition = <TAnimationValue = number>(
  options: TransitionOptions<undefined, TAnimationValue>,
): TransitionCallback => {
  const { isParentMounting, createScopeHooks } = useTransitionScopeContext();
  const scope = options.scope ?? "global";

  const identityRef = useRef<object>({});
  const scopeHooksEntryRef = useRef<{
    scope: TransitionScope;
    boundaryHooks: TransitionScopeHooks;
    combinedHooks: TransitionScopeHooks;
  }>();
  const userHooksRef = useRef<TransitionScopeHooks | undefined>(
    options[TRANSITION_SCOPE_HOOKS],
  );
  userHooksRef.current = options[TRANSITION_SCOPE_HOOKS];

  if (
    !scopeHooksEntryRef.current ||
    scopeHooksEntryRef.current.scope !== scope
  ) {
    const boundaryHooks = createScopeHooks(scope);
    scopeHooksEntryRef.current = {
      scope,
      boundaryHooks,
      combinedHooks: {
        onActivate: (direction) => {
          boundaryHooks.onActivate?.(direction);
          userHooksRef.current?.onActivate?.(direction);
        },
        onDeactivate: (direction) => {
          userHooksRef.current?.onDeactivate?.(direction);
          boundaryHooks.onDeactivate?.(direction);
        },
      },
    };
  }

  const { boundaryHooks, combinedHooks } = scopeHooksEntryRef.current;

  const coreCallback = useMemo(() => {
    return coreTransition<TAnimationValue>({
      ...options,
      ref: options.ref ?? identityRef.current,
      scope,
      [TRANSITION_SCOPE_HOOKS]: combinedHooks,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, scope, combinedHooks]);

  return (element) => {
    if (element) {
      boundaryHooks.onActivate?.("in");
      if (scope === "local" && !isParentMounting()) {
        // keep activation temporary; deactivate immediately to avoid leaking state
        boundaryHooks.onDeactivate?.("in");
        return () => {};
      }
    }

    const cleanup = coreCallback(element);
    return cleanup;
  };
};
