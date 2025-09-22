import { transition as _transition } from "@ssgoi/core";
import type { Directive } from "vue";
import type { Transition, TransitionKey } from "@ssgoi/core";

type TransitionCleanup = ReturnType<ReturnType<typeof _transition>>;
type TransitionHTMLElement = HTMLElement & {
  _ssgoiCleanup?: TransitionCleanup;
};

export const transition = _transition;

// Vue directive for element transitions
export const vTransition: Directive<
  HTMLElement,
  (Transition & { key?: TransitionKey }) | undefined
> = {
  mounted(el, binding) {
    const element = el as TransitionHTMLElement;
    if (!binding.value) {
      console.warn(
        "[SSGOI] v-transition directive requires a configuration object",
      );
      return;
    }

    const transitionConfig = binding.value;

    setTimeout(() => {
      const cleanup = transition({
        key: transitionConfig.key,
        in: transitionConfig.in,
        out: transitionConfig.out,
        ref: el,
        scope: transitionConfig.scope,
      })(el);

      // Store cleanup function on element for unmounted hook
      element._ssgoiCleanup = cleanup ?? undefined;
    }, 0);
  },
  unmounted(el) {
    const element = el as TransitionHTMLElement;
    // Call cleanup if it exists
    const cleanup = element._ssgoiCleanup;
    if (cleanup) {
      cleanup();
      delete element._ssgoiCleanup;
    }
  },
};
