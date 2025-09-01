import {
	activateScope,
	deactivateScope,
	type ScopeId,
} from "./scope-coordinator";
import type {
	StrategyContext,
	TransitionStrategy,
} from "./transition-strategy";
import { createDefaultStrategy } from "./transition-strategy";

export type ScopeTransitionStrategy<TAnimationValue = number> =
	TransitionStrategy<TAnimationValue> & {
		scopeId: ScopeId;
		coordinationMode: "sync" | "stagger" | "sequence";
		staggerDelay?: number;
	};

/**
 * Creates a scope-aware transition strategy
 *
 * This strategy coordinates animations within a scope, ensuring that
 * all elements in the scope animate together with proper timing.
 */
export function createScopeStrategy<TAnimationValue = number>(
	scopeId: ScopeId,
	options: {
		coordinationMode?: "sync" | "stagger" | "sequence";
		staggerDelay?: number;
	} = {},
): (
	context: StrategyContext<TAnimationValue>,
) => ScopeTransitionStrategy<TAnimationValue> {
	const { coordinationMode = "sync", staggerDelay = 50 } = options;

	return (
		context: StrategyContext<TAnimationValue>,
	): ScopeTransitionStrategy<TAnimationValue> => {
		const baseStrategy = createDefaultStrategy(context);

		return {
			...baseStrategy,
			scopeId,
			coordinationMode,
			staggerDelay,

			runIn: async (configs) => {
				// Activate the scope
				activateScope(scopeId);

				// Use base strategy for now - scope coordination will be handled separately
				return baseStrategy.runIn(configs);
			},

			runOut: async (configs) => {
				// Deactivate the scope
				deactivateScope(scopeId);

				// Use base strategy for now - scope coordination will be handled separately
				return baseStrategy.runOut(configs);
			},
		};
	};
}

/**
 * Creates a scope transition with a specific coordination mode
 */
export function createCoordinatedScopeTransition(
	scopeId: ScopeId,
	coordinationMode: "sync" | "stagger" | "sequence" = "sync",
	staggerDelay: number = 50,
) {
	return (
		key: string,
		element: HTMLElement,
		config: any, // Use any for now to avoid complex type issues
	) => {
		const strategy = createScopeStrategy(scopeId, {
			coordinationMode,
			staggerDelay,
		});

		// This would need to be integrated with the main transition system
		// For now, return a placeholder
		return {
			key,
			element,
			config,
			strategy,
		};
	};
}
