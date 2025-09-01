import type { ScopeId } from "./scope-coordinator";
import {
	activateScope,
	getScopeElements,
	isScopeActive,
	registerScopeElement,
	unregisterScopeElement,
} from "./scope-coordinator";
import { transition } from "./transition";
import type {
	TransitionConfig,
} from "./types";

export type ScopeTransitionOptions<TAnimationValue = number> = {
	scopeId: ScopeId;
	delay?: number;
	stagger?: number;
	autoActivate?: boolean;
	in?: (element: HTMLElement) => TransitionConfig<TAnimationValue>;
	out?: (element: HTMLElement) => TransitionConfig<TAnimationValue>;
};

/**
 * Scope-based transition function
 *
 * Creates a transition that is coordinated with other elements in the same scope.
 * Elements within the same scope will animate together with synchronized timing.
 *
 * @param options - Configuration object with scope information
 * @param options.scopeId - Unique identifier for the scope
 * @param options.delay - Delay before starting the animation (in ms)
 * @param options.stagger - Stagger delay between elements in the scope (in ms)
 * @param options.autoActivate - Whether to automatically activate the scope when element enters
 *
 * @returns TransitionCallback function to be used as a ref
 *
 * @example
 * ```tsx
 * // Multiple elements in the same scope will animate together
 * <div ref={scopeTransition({
 *   scopeId: 'list-items',
 *   stagger: 50,
 *   in: (element) => ({
 *     prepare: (el) => el.style.opacity = '0',
 *     tick: (progress) => el.style.opacity = progress.toString(),
 *   }),
 *   out: (element) => ({
 *     prepare: (el) => el.style.opacity = '1',
 *     tick: (progress) => el.style.opacity = (1 - progress).toString(),
 *   }),
 * })} />
 * ```
 */
export function scopeTransition<TAnimationValue extends number = number>(
	options: ScopeTransitionOptions<TAnimationValue>,
) {
	const {
		scopeId,
		delay = 0,
		stagger = 0,
		autoActivate = true,
		in: inConfig,
		out: outConfig,
	} = options;

	return (element: HTMLElement | null) => {
		if (!element) {
			return;
		}

		// Check if element is already registered in this scope
		const existingElements = getScopeElements(scopeId);
		const isAlreadyRegistered = existingElements.some(
			(scopeElement) => scopeElement.element === element,
		);

		// If already registered, don't re-register
		if (isAlreadyRegistered) {
			return;
		}

		// Register element in scope
		if (inConfig) {
			const scopeConfig: TransitionConfig<TAnimationValue> = {
				...inConfig(element),
				wait: async () => {
					const baseWait = inConfig(element).wait;
					if (baseWait) await baseWait();
					if (delay + stagger > 0) {
						await new Promise((resolve) =>
							setTimeout(resolve, delay + stagger),
						);
					}
				},
			};

			registerScopeElement(
				scopeId,
				element,
				scopeConfig,
			);
		}

		console.log(existingElements,element,'<<existingElements')

		// Auto-activate scope if enabled
		if (autoActivate && !isScopeActive(scopeId)) {
			activateScope(scopeId);
		}

		// Create and apply the transition
		const transitionCallback = transition({
			in: inConfig,
			out: (element) => {
				if (outConfig) {
					const config = outConfig(element);
					return {
						...config,
						wait: async () => {
							unregisterScopeElement(scopeId, element);
							if (config.wait) await config.wait();
							// Unregister element from scope when out animation starts
						},
					};
				}
				return {};
			},
		});

		return transitionCallback(element);
	};
}

/**
 * Executes transitions for all elements in a scope
 *
 * @param scopeId - The scope identifier
 * @param transitionType - Type of transition ('in' or 'out')
 * @param options - Additional options
 */
export function executeScopeTransition<TAnimationValue = number>(
	scopeId: ScopeId,
	transitionType: 'in' | 'out',
	options: {
		delay?: number;
		stagger?: number;
		config?: (element: HTMLElement) => TransitionConfig<TAnimationValue>;
	} = {},
) {
	const { delay = 0, stagger = 0, config } = options;
	const elements = getScopeElements(scopeId);

	if (elements.length === 0) return;

	// Execute transitions sequentially with stagger
	elements.forEach((scopeElement, index) => {
		const element = scopeElement.element;
		const elementDelay = delay + (stagger * index);

		setTimeout(() => {
			if (config) {
				const transitionConfig = config(element);
				const transitionCallback = transition({
					[transitionType]: () => transitionConfig,
				});
				transitionCallback(element);
			}
		}, elementDelay);
	});
}

/**
 * Creates a scope transition with predefined configurations
 *
 * @param scopeId - The scope identifier
 * @param baseConfig - Base transition configuration
 * @param options - Additional options
 *
 * @returns A function that creates scope transitions
 */
export function createScopeTransition<TAnimationValue extends number = number>(
	scopeId: ScopeId,
	baseConfig: TransitionConfig<TAnimationValue>,
	options: {
		delay?: number;
		stagger?: number;
		autoActivate?: boolean;
	} = {},
) {
	return (element: HTMLElement) => {
		return scopeTransition({
			scopeId,
			delay: options.delay,
			stagger: options.stagger,
			autoActivate: options.autoActivate,
			in: () => baseConfig,
		})(element);
	};
}

/**
 * Batch transition for multiple elements in a scope
 *
 * @param scopeId - The scope identifier
 * @param elements - Array of elements to animate
 * @param config - Transition configuration
 * @param options - Additional options
 */
export function batchScopeTransition<TAnimationValue = number>(
	scopeId: ScopeId,
	elements: HTMLElement[],
	config: TransitionConfig<TAnimationValue>,
	options: {
		delay?: number;
		stagger?: number;
	} = {},
) {
	const { delay = 0, stagger = 0 } = options;

	// Register all elements in scope
	elements.forEach((element, index) => {
		const elementDelay = delay + (stagger * index);
		const scopeConfig: TransitionConfig<TAnimationValue> = {
			...config,
			wait: async () => {
				if (config.wait) await config.wait();
				if (elementDelay > 0) {
					await new Promise((resolve) => setTimeout(resolve, elementDelay));
				}
			},
		};

		registerScopeElement(
			scopeId,
			element,
			scopeConfig as any,
		);
	});

	// Activate scope
	activateScope(scopeId);
}
