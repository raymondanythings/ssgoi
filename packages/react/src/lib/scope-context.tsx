"use client";

import { createContext, useCallback, useContext, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import type { TransitionScope, TransitionScopeHooks } from "@ssgoi/core";

const noopHooks: TransitionScopeHooks = {
  onActivate: () => {},
  onDeactivate: () => {},
};

type TransitionScopeContextValue = {
  isParentMounting: () => boolean;
  createScopeHooks: (scope: TransitionScope) => TransitionScopeHooks;
};

const defaultContextValue: TransitionScopeContextValue = {
  isParentMounting: () => false,
  createScopeHooks: () => noopHooks,
};

const TransitionScopeContext =
  createContext<TransitionScopeContextValue>(defaultContextValue);

// eslint-disable-next-line react-refresh/only-export-components
export const useTransitionScopeContext = () =>
  useContext(TransitionScopeContext);

export const TransitionScopeBoundary = ({
  children,
}: {
  children: ReactNode;
}) => {
  const activeCountRef = useRef(0);

  const createScopeHooks = useCallback(
    (_scope: TransitionScope): TransitionScopeHooks => {
      let active = false;
      return {
        onActivate: () => {
          if (active) return;
          active = true;
          activeCountRef.current += 1;
        },
        onDeactivate: () => {
          if (!active) return;
          active = false;
          activeCountRef.current = Math.max(0, activeCountRef.current - 1);
        },
      };
    },
    [],
  );

  const contextValue = useMemo(
    () => ({
      isParentMounting: () => activeCountRef.current > 0,
      createScopeHooks,
    }),
    [createScopeHooks],
  );

  return (
    <TransitionScopeContext.Provider value={contextValue}>
      {children}
    </TransitionScopeContext.Provider>
  );
};
