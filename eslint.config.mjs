import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import prettier from "eslint-config-prettier";

const sourceFilePatterns = ["main.ts", "src/**/*.ts"];

const pluginReviewRules = {
  rules: {
    "require-eslint-directive-description": {
      meta: {
        type: "suggestion",
        docs: { description: "Require descriptions on ESLint directive comments." },
        messages: { missingDescription: "Include a description after -- on this ESLint directive." },
        schema: [],
      },
      create(context) {
        return {
          Program() {
            const sourceCode = context.sourceCode ?? context.getSourceCode();
            const directive = /\beslint-(?:disable|disable-next-line|disable-line|enable)\b/u;
            for (const comment of sourceCode.getAllComments()) {
              const value = comment.value.trim();
              if (!directive.test(value)) continue;
              const descriptionIndex = value.indexOf("--");
              if (descriptionIndex < 0 || value.slice(descriptionIndex + 2).trim().length === 0) {
                context.report({ loc: comment.loc, messageId: "missingDescription" });
              }
            }
          },
        };
      },
    },
    "no-network-interval": {
      meta: {
        type: "problem",
        docs: { description: "Disallow intervals in modules that perform network calls." },
        messages: { found: "Use a self-rescheduling timeout instead of an interval in a networking module." },
        schema: [],
      },
      create(context) {
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        if (!/\b(?:requestUrl|fetch|XMLHttpRequest|sendBeacon)\b/u.test(sourceCode.text)) return {};
        return {
          CallExpression(node) {
            const callee = node.callee;
            const name = callee.type === "Identifier"
              ? callee.name
              : callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier"
                ? callee.property.name
                : null;
            if (name === "setInterval") context.report({ node: callee, messageId: "found" });
          },
        };
      },
    },
    "no-codemirror-theme-styles": {
      meta: {
        type: "problem",
        docs: { description: "Keep static CodeMirror styling in CSS." },
        messages: { found: "Move CodeMirror theme styling from TypeScript to the plugin stylesheet." },
        schema: [],
      },
      create(context) {
        return {
          CallExpression(node) {
            const callee = node.callee;
            if (
              callee.type === "MemberExpression"
              && !callee.computed
              && callee.object.type === "Identifier"
              && callee.object.name === "EditorView"
              && callee.property.type === "Identifier"
              && callee.property.name === "theme"
            ) context.report({ node: callee, messageId: "found" });
          },
        };
      },
    },
  },
};

export default defineConfig([
  globalIgnores([
    "node_modules/**", "main.js", ".test-dist/**", "test/**", "scripts/**",
    "**/*.mjs", "test-vault/**",
  ]),
  ...obsidianmd.configs.recommended,
  {
    files: ["manifest.json"],
    rules: { "obsidianmd/validate-manifest": "off" },
  },
  {
    files: sourceFilePatterns,
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "plugin-review": pluginReviewRules },
    rules: {
      "plugin-review/require-eslint-directive-description": "error",
      "plugin-review/no-network-interval": "error",
      "plugin-review/no-codemirror-theme-styles": "error",
    },
  },
  prettier,
]);
