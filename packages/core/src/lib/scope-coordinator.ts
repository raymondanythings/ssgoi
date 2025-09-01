import type { TransitionConfig, TransitionKey } from "./types";

/**
 * Scope Transition Coordinator
 *
 * Manages scope-based transitions where multiple elements within a scope
 * animate together with synchronized timing and coordination.
 */

export type ScopeId = string | symbol;

export type ScopeContext = {
	scopeId: ScopeId;
	parentScopeId?: ScopeId;
	level: number;
	isActive: boolean;
	elementCount: number;
};

export type ScopeTransitionConfig = {
	scopeId: ScopeId;
	transition: TransitionConfig;
	delay?: number;
	stagger?: number;
};

export type ScopeElement<TAnimationValue extends number = number> = {
	element: HTMLElement;
	scopeId: ScopeId;
	config: TransitionConfig<TAnimationValue>;
};

// Global scope registry
const scopeRegistry = new Map<ScopeId, ScopeContext>();
const scopeElements = new Map<ScopeId, Set<ScopeElement>>();
const activeScopes = new Set<ScopeId>();

/**
 * Creates a new scope context
 */
export function createScope(
	scopeId: ScopeId,
	parentScopeId?: ScopeId,
): ScopeContext {
	const parentLevel = parentScopeId
		? (scopeRegistry.get(parentScopeId)?.level ?? 0)
		: 0;

	const context: ScopeContext = {
		scopeId,
		parentScopeId,
		level: parentLevel + 1,
		isActive: false,
		elementCount: 0,
	};

	scopeRegistry.set(scopeId, context);
	scopeElements.set(scopeId, new Set());

	return context;
}

/**
 * Registers an element within a scope
 */
export function registerScopeElement<TAnimationValue extends number = number>(
	scopeId: ScopeId,
	element: HTMLElement,
	config: TransitionConfig<TAnimationValue>,
): void {
	// Ensure scope exists
	if (!scopeRegistry.has(scopeId)) {
		createScope(scopeId);
	}

	const scopeContext = scopeRegistry.get(scopeId);
	if (!scopeContext) return;
	const elements = scopeElements.get(scopeId);
	if (!elements) return;


	const scopeElement: ScopeElement<TAnimationValue> = {
		element,
		scopeId,
		config,
	};

	elements.add(scopeElement as unknown as ScopeElement<number>);
	scopeContext.elementCount = elements.size;
 
}

/**
 * Unregisters an element from a scope
 */
export function unregisterScopeElement(
	scopeId: ScopeId,
	element: HTMLElement,
): void {
	const elements = scopeElements.get(scopeId);
	if (!elements) return;

	const scopeContext = scopeRegistry.get(scopeId);
	if (!scopeContext) return;

	// Remove element
	for (const scopeElement of elements) {
		if (scopeElement.element === element) {
			elements.delete(scopeElement);
			break;
		}
	}

	scopeContext.elementCount = elements.size;

	// Clean up empty scope
	if (scopeContext.elementCount === 0) {
		scopeRegistry.delete(scopeId);
		scopeElements.delete(scopeId);
		activeScopes.delete(scopeId);
	}
}

/**
 * Activates a scope and all its child scopes
 */
export function activateScope(scopeId: ScopeId): void {
	const scopeContext = scopeRegistry.get(scopeId);
	if (!scopeContext) return;

	scopeContext.isActive = true;
	activeScopes.add(scopeId);

	// Activate child scopes
	for (const [childScopeId, childContext] of scopeRegistry) {
		if (childContext.parentScopeId === scopeId) {
			activateScope(childScopeId);
		}
	}
}

/**
 * Deactivates a scope and all its child scopes
 */
export function deactivateScope(scopeId: ScopeId): void {
	const scopeContext = scopeRegistry.get(scopeId);
	if (!scopeContext) return;

	scopeContext.isActive = false;
	activeScopes.delete(scopeId);

	// Deactivate child scopes
	for (const [childScopeId, childContext] of scopeRegistry) {
		if (childContext.parentScopeId === scopeId) {
			deactivateScope(childScopeId);
		}
	}
}

/**
 * Gets all elements in a scope
 */
export function getScopeElements(scopeId: ScopeId): ScopeElement[] {
	const elements = scopeElements.get(scopeId);
	return elements ? Array.from(elements) : [];
}

/**
 * Gets the scope context
 */
export function getScopeContext(scopeId: ScopeId): ScopeContext | undefined {
	return scopeRegistry.get(scopeId);
}

/**
 * Checks if a scope is active
 */
export function isScopeActive(scopeId: ScopeId): boolean {
	return activeScopes.has(scopeId);
}

/**
 * Gets all active scopes
 */
export function getActiveScopes(): ScopeId[] {
	return Array.from(activeScopes);
}

/**
 * Cleans up all scopes (for testing or reset purposes)
 */
export function cleanupAllScopes(): void {
	scopeRegistry.clear();
	scopeElements.clear();
	activeScopes.clear();
}
