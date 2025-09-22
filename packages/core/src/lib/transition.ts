import { createTransitionCallback } from "./create-transition-callback";
import {
  StrategyContext,
  TRANSITION_STRATEGY,
  TransitionStrategy,
} from "./transition-strategy";
import { TRANSITION_SCOPE_HOOKS } from "./types";
import type {
  Transition,
  TransitionCallback,
  TransitionOptions,
  TransitionScope,
  TransitionScopeHooks,
} from "./types";
import type { TransitionKey } from "./types";
import { parseCallerLocation } from "./utils/parse-caller-location";

/**
 * Centralized transition management
 * Uses string/symbol keys for all storage
 */

// Map to store transition definitions by key
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const transitionDefinitions = new Map<TransitionKey, Transition<any, any>>();

// Map to store transition callbacks by key
type TransitionCallbackEntry = {
  callback: TransitionCallback;
  scope: TransitionScope;
  scopeHooks?: TransitionScopeHooks;
};

const transitionCallbacks = new Map<TransitionKey, TransitionCallbackEntry>();

type AutoKeyMetadata = {
  baseKey: string;
};

const autoKeyMetadata = new Map<TransitionKey, AutoKeyMetadata>();
const autoKeyUsage = new Map<string, { active: number; nextSuffix: number }>();
let symbolAutoKeyCounter = 0;

function allocateAutoKey(baseKey: string): TransitionKey {
  const record =
    autoKeyUsage.get(baseKey) ?? ({ active: 0, nextSuffix: 1 } as const);

  let key: TransitionKey = baseKey as TransitionKey;

  if (record.active > 0) {
    key = `${baseKey}#${record.nextSuffix}` as const;
  }

  const nextSuffix =
    record.active > 0 ? record.nextSuffix + 1 : record.nextSuffix;

  autoKeyUsage.set(baseKey, {
    active: record.active + 1,
    nextSuffix,
  });
  autoKeyMetadata.set(key, { baseKey });
  return key;
}

/**
 * Registers a transition with a key and returns the callback
 * Usage: registerTransition('fade', { in: fadeIn, out: fadeOut })
 */
function registerTransition<TAnimationValue = number>(
  key: TransitionKey,
  transition: Transition<undefined, TAnimationValue>,
  scope: TransitionScope,
  strategy?: (
    context: StrategyContext<TAnimationValue>,
  ) => TransitionStrategy<TAnimationValue>,
  scopeHooks?: TransitionScopeHooks,
): TransitionCallback {
  transitionDefinitions.set(key, transition);

  // Return existing callback if it exists
  const existingEntry = transitionCallbacks.get(key);
  if (
    existingEntry &&
    existingEntry.scope === scope &&
    existingEntry.scopeHooks === scopeHooks
  ) {
    return existingEntry.callback;
  }

  // Create new callback
  const callback = createTransitionCallback(
    () => {
      const trans = transitionDefinitions.get(key);
      if (!trans) {
        console.warn(`Transition "${String(key)}" not found`);
        return {};
      }
      return trans;
    },
    {
      strategy,
      onCleanupEnd: () => unregisterTransition(key),
      scope,
      scopeHooks,
    },
  );
  transitionCallbacks.set(key, { callback, scope, scopeHooks });
  return callback;
}

/**
 * Unregisters a transition and cleans up associated resources
 */
function unregisterTransition(key: TransitionKey): void {
  transitionDefinitions.delete(key);
  transitionCallbacks.delete(key);

  const metadata = autoKeyMetadata.get(key);
  if (metadata) {
    autoKeyMetadata.delete(key);
    const record = autoKeyUsage.get(metadata.baseKey);
    if (record) {
      const active = Math.max(0, record.active - 1);
      autoKeyUsage.set(metadata.baseKey, {
        active,
        nextSuffix: active === 0 ? 1 : record.nextSuffix,
      });
    }
  }
}

// ---------------------------------------------
// Auto key generation
// ---------------------------------------------

export function generateAutoKey(): TransitionKey {
  // Fallback to a stable key from the callsite when available
  const location = parseCallerLocation(new Error().stack);
  if (location) {
    const baseKey = `auto_${location.file}_${location.line}_${location.column}`;
    return allocateAutoKey(baseKey);
  }

  // Fallback to a unique symbol when callsite is unavailable
  const baseKey = `auto_symbol_${symbolAutoKeyCounter++}`;
  const key = Symbol(`ssgoi_auto_${baseKey}`);
  autoKeyMetadata.set(key, { baseKey });
  return key;
}

// Optional GC-based cleanup registry (browser/node supporting FinalizationRegistry)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FinalizationRegistryCtor = (globalThis as any).FinalizationRegistry as
  | (new (cb: (heldValue: TransitionKey) => void) => {
      register: (target: object, heldValue: TransitionKey) => void;
    })
  | undefined;
const __cleanupRegistry = FinalizationRegistryCtor
  ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (new (FinalizationRegistryCtor as any)((key: TransitionKey) => {
      try {
        unregisterTransition(key);
      } catch {
        /* empty */
      }
    }) as { register: (target: object, heldValue: TransitionKey) => void })
  : undefined;

/**
 * Framework-agnostic transition function that can be used as a ref
 *
 * @description
 * Creates a transition that can be attached to DOM elements via ref.
 * Manages entrance and exit animations with a complete lifecycle system.
 *
 * **IN Animation Lifecycle (Element Entering):**
 * 1. `prepare` - Setup element's initial state (e.g., opacity: 0)
 * 2. `wait` - Optional async delay before animation starts
 * 3. `onStart` - Called when animation begins
 * 4. `tick` - Called on each animation frame with progress value (0 → 1)
 * 5. `onEnd` - Called when animation completes
 *
 * **OUT Animation Lifecycle (Element Exiting):**
 * 1. `prepare` - Setup element's initial state for exit
 * 2. `wait` - Optional async delay before animation starts
 * 3. `onStart` - Called when animation begins
 * 4. `tick` - Called on each animation frame with progress value (1 → 0)
 * 5. `onEnd` - Called when animation completes and element is removed
 *
 * The `key` parameter is crucial for transition management - it uniquely identifies
 * each transition instance, allowing the system to track, cleanup, and prevent
 * conflicts between multiple transitions on the same element.
 *
 * @param {object} options - Configuration object
 * @param {TransitionKey} options.key - Unique identifier for this transition instance.
 *                                      Can be string or symbol. Used to manage and cleanup
 *                                      transitions internally.
 * @param {Function} options.in - Configuration for entrance animation.
 *                                Returns TransitionConfig with lifecycle hooks.
 * @param {Function} options.out - Configuration for exit animation.
 *                                 Returns TransitionConfig with lifecycle hooks.
 *
 * @template TAnimationValue - The type of value being animated (number | object)
 *
 * @returns {TransitionCallback} A callback function to be used as a ref
 *
 * @example
 * ```tsx
 * // Simple fade transition
 * <div ref={transition({
 *   key: 'hero-fade',
 *   in: (element) => ({
 *     prepare: (el) => el.style.opacity = '0',
 *     tick: (progress) => el.style.opacity = progress.toString(),
 *   }),
 *   out: (element) => ({
 *     tick: (progress) => el.style.opacity = progress.toString(),
 *   })
 * })} />
 * ```
 */
export function transition<TAnimationValue = number>(
  options: TransitionOptions<undefined, TAnimationValue> & {
    [TRANSITION_STRATEGY]?: (
      context: StrategyContext<TAnimationValue>,
    ) => TransitionStrategy<TAnimationValue>;
  },
): TransitionCallback {
  const resolvedKey = options.key ?? generateAutoKey();
  const scope: TransitionScope = options.scope ?? "global";
  const scopeHooks = options[TRANSITION_SCOPE_HOOKS];

  // Register GC cleanup for auto-generated keys bound to a ref
  if (options.ref && __cleanupRegistry) {
    try {
      __cleanupRegistry.register(options.ref, resolvedKey);
    } catch {
      /* empty */
    }
  }
  return registerTransition(
    resolvedKey,
    {
      in: options.in,
      out: options.out,
    },
    scope,
    options[TRANSITION_STRATEGY],
    scopeHooks,
  );
}
