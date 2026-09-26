import tseslint from "typescript-eslint";

// Biome owns the repository's TypeScript lint surface. Keep only rules that
// Biome 2.5.14 cannot implement and that TypeScript compilation does not cover.
export default tseslint.config({
  files: ["src/**/*.ts"],
  ignores: ["dist/**", "node_modules/**"],
  languageOptions: { parser: tseslint.parser },
  plugins: { "@typescript-eslint": tseslint.plugin },
  rules: {
    "@typescript-eslint/ban-ts-comment": "error",
    "@typescript-eslint/no-empty-object-type": "error",
    "@typescript-eslint/triple-slash-reference": "error",
    "no-invalid-regexp": "error",
    "no-unexpected-multiline": "error",
    "no-useless-escape": "error",
  },
});
