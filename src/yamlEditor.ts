import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, indentUnit, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";

export interface YamlProblem {
  /** 1-based line in the whole document, or null when no line is known. */
  line: number | null;
  message: string;
  severity: "error" | "warning";
}

interface YamlTokenState {
  section: "start" | "yaml" | "body";
}

/** A small YAML-frontmatter tokenizer; the Markdown body after `---` is plain text. */
const frontmatterYaml = StreamLanguage.define<YamlTokenState>({
  startState: () => ({ section: "start" }),
  copyState: (state) => ({ ...state }),
  token(stream, state) {
    if (stream.sol() && stream.match(/^---\s*$/)) {
      state.section = state.section === "start" ? "yaml" : "body";
      return "meta";
    }
    if (state.section === "body") {
      stream.skipToEnd();
      return null;
    }
    if (state.section === "start") state.section = "yaml";
    if (stream.eatSpace()) return null;
    if (stream.match("#")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match(/^-(?=\s|$)/)) return "punctuation";
    if (stream.match(/^(?:[^\s:#'"[\]{},][^:#]*?|"[^"]*"|'[^']*')(?=\s*:(?:\s|$))/)) return "propertyName";
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'(?:[^']|'')*'?/)) return "string";
    if (stream.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?=[\s,\]}]|$)/)) return "number";
    if (stream.match(/^(?:true|false|null|~)(?=[\s,\]}]|$)/)) return "atom";
    if (stream.match(/^[:[\]{},|>]/)) return "punctuation";
    stream.eatWhile(/[^\s#:,[\]{}]/);
    if (stream.current() === "") stream.next();
    return "string";
  },
});

// Theme variables keep the editor aligned with the user's Obsidian theme.
const highlight = HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--text-accent)" },
  { tag: tags.string, color: "var(--text-normal)" },
  { tag: tags.number, color: "var(--color-orange)" },
  { tag: tags.atom, color: "var(--color-purple)" },
  { tag: tags.comment, color: "var(--text-faint)", fontStyle: "italic" },
  { tag: tags.meta, color: "var(--text-faint)" },
  { tag: tags.punctuation, color: "var(--text-muted)" },
]);

const setProblems = StateEffect.define<YamlProblem[]>();

const problemLines = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setProblems)) continue;
      const builder = new RangeSetBuilder<Decoration>();
      const lines = [...new Set(effect.value
        .map((problem) => problem.line)
        .filter((line): line is number => line !== null && line >= 1 && line <= transaction.state.doc.lines))]
        .sort((a, b) => a - b);
      for (const lineNumber of lines) {
        const line = transaction.state.doc.line(lineNumber);
        const severity = effect.value.find((problem) => problem.line === lineNumber)?.severity ?? "error";
        builder.add(line.from, line.from, Decoration.line({ class: `mdbase-yaml-problem-line is-${severity}` }));
      }
      next = builder.finish();
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * A CodeMirror 6 editor for type YAML. Obsidian supplies CodeMirror at runtime;
 * the instance is kept across workspace re-renders so undo history and the
 * cursor survive typing.
 */
export class YamlSourceEditor {
  readonly dom: HTMLElement;
  private readonly view: EditorView;
  private readonly editable = new Compartment();
  private applyingExternalChange = false;

  /** `labelledBy` names the visible label's id; an aria-label would surface as a hover tooltip in Obsidian. */
  constructor(options: { doc: string; readOnly: boolean; labelledBy: string; onChange(doc: string): void }) {
    this.view = new EditorView({
      state: EditorState.create({
        doc: options.doc,
        extensions: [
          lineNumbers(),
          history(),
          indentUnit.of("  "),
          EditorState.tabSize.of(2),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          frontmatterYaml,
          syntaxHighlighting(highlight),
          problemLines,
          EditorView.lineWrapping,
          this.editable.of(this.editability(options.readOnly)),
          EditorView.contentAttributes.of({
            "aria-labelledby": options.labelledBy,
            "data-focus-key": "yaml-editor",
            spellcheck: "false",
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !this.applyingExternalChange) options.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    this.dom = this.view.dom;
    this.dom.addClass("mdbase-yaml-editor");
  }

  get value(): string {
    return this.view.state.doc.toString();
  }

  setValue(doc: string): void {
    if (doc === this.value) return;
    this.applyingExternalChange = true;
    try {
      this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: doc } });
    } finally {
      this.applyingExternalChange = false;
    }
  }

  setReadOnly(readOnly: boolean): void {
    this.view.dispatch({ effects: this.editable.reconfigure(this.editability(readOnly)) });
  }

  setProblems(problems: YamlProblem[]): void {
    this.view.dispatch({ effects: setProblems.of(problems) });
  }

  revealLine(line: number): void {
    if (line < 1 || line > this.view.state.doc.lines) return;
    const position = this.view.state.doc.line(line).from;
    this.view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
    this.view.focus();
  }

  destroy(): void {
    this.view.destroy();
  }

  private editability(readOnly: boolean) {
    return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
  }
}

/** Best-effort line for a YAML parser error message (`line 3`, `(3:5)`), offset by the frontmatter delimiter. */
export function yamlErrorLine(message: string, frontmatterStartLine = 2): number | null {
  const match = message.match(/line (\d+)/i) ?? message.match(/\((\d+):\d+\)/);
  if (!match) return null;
  return Number(match[1]) + frontmatterStartLine - 1;
}

/** First line declaring `key:` (at any indentation) in the document, 1-based. */
export function yamlKeyLine(document: string, key: string): number | null {
  if (!key) return null;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(`^\\s*(?:-\\s+)?["']?${escaped}["']?\\s*:`);
  const lines = document.split("\n");
  const index = lines.findIndex((line) => matcher.test(line));
  return index === -1 ? null : index + 1;
}
