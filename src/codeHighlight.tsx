import { ReactNode } from "react";

// Lightweight fenced-code highlighter for assistant markdown. Tokenizes
// comments, strings, numbers, keywords, and JSX/HTML tags without a highlighter
// package — Monaco is already in the editor and would be far too heavy per bubble.

const ALIAS: Record<string, string> = {
  javascript: "js",
  typescript: "ts",
  jsx: "js",
  tsx: "ts",
  node: "js",
  py: "python",
  python3: "python",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  powershell: "bash",
  ps1: "bash",
  yml: "yaml",
  csharp: "cs",
  "c++": "cpp",
  "c#": "cs",
  golang: "go",
  markdown: "md",
  xml: "html",
  svg: "html",
};

const KEYWORDS: Record<string, string[]> = {
  js: [
    "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default",
    "delete", "do", "else", "export", "extends", "finally", "for", "from", "function", "if", "import",
    "in", "instanceof", "let", "new", "of", "return", "static", "super", "switch", "this", "throw",
    "try", "typeof", "var", "void", "while", "with", "yield", "true", "false", "null", "undefined",
  ],
  ts: [
    "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "declare",
    "default", "delete", "do", "else", "enum", "export", "extends", "finally", "for", "from",
    "function", "if", "implements", "import", "in", "infer", "instanceof", "interface", "keyof",
    "let", "namespace", "new", "of", "private", "protected", "public", "readonly", "return",
    "satisfies", "static", "super", "switch", "this", "throw", "try", "type", "typeof", "var",
    "void", "while", "with", "yield", "true", "false", "null", "undefined", "never", "unknown", "any",
  ],
  python: [
    "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif",
    "else", "except", "False", "finally", "for", "from", "global", "if", "import", "in", "is",
    "lambda", "None", "nonlocal", "not", "or", "pass", "raise", "return", "True", "try", "while",
    "with", "yield",
  ],
  rust: [
    "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern",
    "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub",
    "ref", "return", "self", "Self", "static", "struct", "super", "trait", "true", "type", "unsafe",
    "use", "where", "while",
  ],
  go: [
    "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for",
    "func", "go", "goto", "if", "import", "interface", "map", "package", "range", "return", "select",
    "struct", "switch", "type", "var", "true", "false", "nil",
  ],
  java: [
    "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const",
    "continue", "default", "do", "double", "else", "enum", "extends", "final", "finally", "float",
    "for", "if", "implements", "import", "instanceof", "int", "interface", "long", "native", "new",
    "package", "private", "protected", "public", "return", "short", "static", "strictfp", "super",
    "switch", "synchronized", "this", "throw", "throws", "transient", "try", "void", "volatile",
    "while", "true", "false", "null",
  ],
  cs: [
    "abstract", "as", "async", "await", "base", "bool", "break", "byte", "case", "catch", "char",
    "checked", "class", "const", "continue", "decimal", "default", "delegate", "do", "double",
    "else", "enum", "event", "explicit", "extern", "false", "finally", "fixed", "float", "for",
    "foreach", "goto", "if", "implicit", "in", "int", "interface", "internal", "is", "lock", "long",
    "namespace", "new", "null", "object", "operator", "out", "override", "params", "private",
    "protected", "public", "readonly", "ref", "return", "sbyte", "sealed", "short", "sizeof",
    "stackalloc", "static", "string", "struct", "switch", "this", "throw", "true", "try", "typeof",
    "uint", "ulong", "unchecked", "unsafe", "ushort", "using", "virtual", "void", "volatile", "while",
  ],
  cpp: [
    "alignas", "alignof", "and", "asm", "auto", "bool", "break", "case", "catch", "char", "class",
    "const", "consteval", "constexpr", "continue", "decltype", "default", "delete", "do", "double",
    "else", "enum", "explicit", "export", "extern", "false", "float", "for", "friend", "goto", "if",
    "inline", "int", "long", "mutable", "namespace", "new", "noexcept", "not", "nullptr", "operator",
    "or", "private", "protected", "public", "return", "short", "signed", "sizeof", "static", "struct",
    "switch", "template", "this", "throw", "true", "try", "typedef", "typeid", "typename", "union",
    "unsigned", "using", "virtual", "void", "volatile", "while",
  ],
  c: [
    "auto", "break", "case", "char", "const", "continue", "default", "do", "double", "else", "enum",
    "extern", "float", "for", "goto", "if", "inline", "int", "long", "register", "restrict", "return",
    "short", "signed", "sizeof", "static", "struct", "switch", "typedef", "union", "unsigned", "void",
    "volatile", "while",
  ],
  bash: [
    "alias", "bg", "bind", "break", "case", "cd", "command", "continue", "declare", "do", "done",
    "echo", "elif", "else", "esac", "eval", "exec", "exit", "export", "fi", "for", "function", "if",
    "in", "local", "readonly", "return", "select", "set", "shift", "then", "time", "trap", "true",
    "false", "until", "while",
  ],
  sql: [
    "add", "all", "alter", "and", "as", "asc", "between", "by", "case", "create", "delete", "desc",
    "distinct", "drop", "else", "end", "exists", "from", "group", "having", "in", "inner", "insert",
    "into", "is", "join", "key", "left", "like", "limit", "not", "null", "on", "or", "order", "outer",
    "primary", "right", "select", "set", "table", "then", "union", "update", "values", "when", "where",
  ],
  json: [],
  yaml: ["true", "false", "null", "yes", "no"],
  md: [],
  css: ["important", "from", "to"],
  html: [],
};

function canonLang(lang?: string): string {
  const raw = (lang || "").toLowerCase().replace(/^\./, "");
  return ALIAS[raw] || raw;
}

type Kind = "kw" | "str" | "com" | "num" | "type" | "fn" | "op" | "tag" | "attr";

function span(kind: Kind, text: string, key: number): ReactNode {
  return (
    <span key={key} className={`tok-${kind}`}>
      {text}
    </span>
  );
}

function isTagLang(L: string): boolean {
  return L === "js" || L === "ts" || L === "html" || L === "xml" || L === "svg";
}

// One-pass tokenizer. Order matters: comments and strings are consumed before
// identifiers so `//` inside a string stays a string. JSX/HTML tags are taken
// before `<` can be treated as a comparison operator.
export function highlightCode(code: string, lang?: string): ReactNode {
  const L = canonLang(lang);
  const kws = new Set(KEYWORDS[L] ?? (L ? KEYWORDS.js : []));
  const hashComments = L === "python" || L === "bash" || L === "yaml" || L === "toml";
  const tags = isTagLang(L);
  const parts: ReactNode[] = [];
  let i = 0;
  let n = 0;
  const pushPlain = (s: string) => {
    if (s) parts.push(s);
  };

  while (i < code.length) {
    const c = code[i];
    const next = code[i + 1];

    if (c === "/" && next === "/" && !hashComments) {
      const end = code.indexOf("\n", i);
      const take = end < 0 ? code.length : end;
      parts.push(span("com", code.slice(i, take), n++));
      i = take;
      continue;
    }
    if (c === "/" && next === "*" && !hashComments) {
      const end = code.indexOf("*/", i + 2);
      const take = end < 0 ? code.length : end + 2;
      parts.push(span("com", code.slice(i, take), n++));
      i = take;
      continue;
    }
    if (c === "#" && hashComments) {
      const end = code.indexOf("\n", i);
      const take = end < 0 ? code.length : end;
      parts.push(span("com", code.slice(i, take), n++));
      i = take;
      continue;
    }
    if (tags && code.startsWith("<!--", i)) {
      const end = code.indexOf("-->", i + 4);
      const take = end < 0 ? code.length : end + 3;
      parts.push(span("com", code.slice(i, take), n++));
      i = take;
      continue;
    }
    if (tags && c === "<" && next && /[A-Za-z/!]/.test(next)) {
      i = emitTag(code, i, parts, () => n++);
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      let j = i + 1;
      while (j < code.length) {
        if (code[j] === "\\") {
          j += 2;
          continue;
        }
        if (code[j] === q) {
          j++;
          break;
        }
        // Template ${...} — keep the interpolation visible as code, not string.
        if (q === "`" && code[j] === "$" && code[j + 1] === "{") break;
        j++;
      }
      parts.push(span("str", code.slice(i, j), n++));
      i = j;
      continue;
    }
    if (c >= "0" && c <= "9") {
      let j = i + 1;
      while (j < code.length && /[0-9xa-fA-F._]/.test(code[j])) j++;
      parts.push(span("num", code.slice(i, j), n++));
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < code.length && /[A-Za-z0-9_$]/.test(code[j])) j++;
      const word = code.slice(i, j);
      let k = j;
      while (k < code.length && (code[k] === " " || code[k] === "\t")) k++;
      if (kws.has(word)) parts.push(span("kw", word, n++));
      else if (code[k] === "(") parts.push(span("fn", word, n++));
      else if (/^[A-Z]/.test(word) && word.length > 1) parts.push(span("type", word, n++));
      else pushPlain(word);
      i = j;
      continue;
    }
    if ("=>!&|+-*%^~?:".includes(c)) {
      let j = i + 1;
      while (j < code.length && "=>!&|+-*%^~?:".includes(code[j])) j++;
      parts.push(span("op", code.slice(i, j), n++));
      i = j;
      continue;
    }
    pushPlain(c);
    i++;
  }
  return parts.length ? parts : code;
}

function emitTag(code: string, start: number, parts: ReactNode[], nextKey: () => number): number {
  let i = start;
  // <, </, or <>
  let j = i + 1;
  if (code[j] === "/") j++;
  while (j < code.length && /[A-Za-z0-9._-]/.test(code[j])) j++;
  parts.push(span("tag", code.slice(i, j), nextKey()));
  i = j;
  while (i < code.length) {
    const ch = code[i];
    if (ch === ">") {
      parts.push(span("tag", ">", nextKey()));
      return i + 1;
    }
    if (ch === "/" && code[i + 1] === ">") {
      parts.push(span("tag", "/>", nextKey()));
      return i + 2;
    }
    if (ch === '"' || ch === "'") {
      const q = ch;
      let k = i + 1;
      while (k < code.length && code[k] !== q) {
        if (code[k] === "\\") k += 2;
        else k++;
      }
      if (k < code.length) k++;
      parts.push(span("str", code.slice(i, k), nextKey()));
      i = k;
      continue;
    }
    if (ch === "{") {
      // JSX expression — leave it to the main loop.
      return i;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let k = i + 1;
      while (k < code.length && /[A-Za-z0-9_-]/.test(code[k])) k++;
      parts.push(span("attr", code.slice(i, k), nextKey()));
      i = k;
      continue;
    }
    parts.push(ch);
    i++;
  }
  return i;
}

export function fenceLang(className?: string | string[]): string | undefined {
  const s = Array.isArray(className) ? className.join(" ") : className || "";
  return /language-(\w+)/.exec(s)?.[1];
}
