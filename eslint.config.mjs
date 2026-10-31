import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// Focused gate: the Rules of Hooks as a CI ERROR. A hook behind an early return ships as a
// runtime crash (React error #310), not a warning - this config exists because that happened.
// Ordinary hooks rules only; the use() API and React Compiler lint are out of scope.
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/build/**",
      "**/.react-router/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "file-archive/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
