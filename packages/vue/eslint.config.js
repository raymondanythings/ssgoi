import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import pluginVue from "eslint-plugin-vue";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default tseslint.config(
  { ignores: ["dist"] },
  {
    files: ["**/*.ts", "**/*.vue"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      ...pluginVue.configs["flat/recommended"],
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        parser: tseslint.parser,
        ecmaVersion: 2020,
        sourceType: "module",
        extraFileExtensions: [".vue"],
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // Vue 3 specific rules
      "vue/multi-word-component-names": "off", // Allow single-word component names
    },
  },
);
