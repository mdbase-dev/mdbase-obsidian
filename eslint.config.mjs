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
    "untranslated-ui-text": {
      meta: {
        type: "problem",
        docs: { description: "Require Lingui macros for text shown in Obsidian UI." },
        messages: { found: "Wrap UI text in a Lingui macro (t`…`, plural(…)) from @lingui/core/macro." },
        schema: [],
      },
      create(context) {
        const textMethods = new Set(["setText", "setName", "setDesc", "setPlaceholder", "setButtonText", "setTooltip", "setTitle", "appendText", "setWarning"]);
        const textAttributes = new Set(["aria-label", "title", "placeholder", "aria-description"]);
        const textProperties = new Set(["textContent", "innerText", "placeholder", "title", "ariaLabel"]);
        const optionKeys = new Set(["text", "title", "placeholder", "aria-label"]);
        const words = (value) => /[A-Za-z]{2}/u.test(value) && !/^(?:https?:|mailto:)/u.test(value);
        const keyName = (property) => property.type === "Property" && !property.computed
          ? property.key.type === "Identifier" ? property.key.name : String(property.key.value)
          : null;
        const calleeName = (callee) => callee.type === "Identifier" ? callee.name
          : callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier" ? callee.property.name : null;
        // Literal text, including either branch of a conditional or fallback. Tagged
        // templates (t`…`) and calls (plural(…)) are already translated.
        function check(node) {
          if (!node) return;
          if (node.type === "Literal" && typeof node.value === "string" && words(node.value)) context.report({ node, messageId: "found" });
          else if (node.type === "TemplateLiteral" && node.quasis.some((quasi) => words(quasi.value.cooked ?? ""))) context.report({ node, messageId: "found" });
          else if (node.type === "ConditionalExpression") { check(node.consequent); check(node.alternate); }
          else if (node.type === "LogicalExpression") { check(node.left); check(node.right); }
        }
        function checkOptions(node) {
          if (node?.type !== "ObjectExpression") return;
          for (const property of node.properties) {
            const key = keyName(property);
            if (key && optionKeys.has(key)) check(property.value);
            if (key === "attr" && property.value.type === "ObjectExpression") {
              for (const attribute of property.value.properties) {
                const name = keyName(attribute);
                if (name && textAttributes.has(name)) check(attribute.value);
              }
            }
          }
        }
        return {
          CallExpression(node) {
            const name = calleeName(node.callee);
            if (!name) return;
            if (textMethods.has(name)) check(node.arguments[0]);
            else if ((name === "setAttr" || name === "setAttribute") && node.arguments[0]?.type === "Literal" && textAttributes.has(node.arguments[0].value)) check(node.arguments[1]);
            else if (/^create(?:El|Div|Span|Svg)?$/u.test(name)) for (const argument of node.arguments) checkOptions(argument);
            else if (name === "addCommand") for (const property of node.arguments[0]?.properties ?? []) { if (keyName(property) === "name") check(property.value); }
            else if (name === "addRibbonIcon") check(node.arguments[1]);
          },
          NewExpression(node) {
            if (node.callee.type === "Identifier" && node.callee.name === "Notice") check(node.arguments[0]);
          },
          AssignmentExpression(node) {
            const target = node.left;
            if (target.type === "MemberExpression" && !target.computed && target.property.type === "Identifier" && textProperties.has(target.property.name)) check(node.right);
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
    files: sourceFilePatterns,
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "plugin-review": pluginReviewRules },
    rules: {
      "plugin-review/require-eslint-directive-description": "error",
      "plugin-review/no-network-interval": "error",
      "plugin-review/no-codemirror-theme-styles": "error",
      "plugin-review/untranslated-ui-text": "error",
    },
  },
  prettier,
]);
