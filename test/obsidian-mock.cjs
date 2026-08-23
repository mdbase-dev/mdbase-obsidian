function normalizePath(path) {
  return String(path).replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}

function parseYaml(raw) {
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Mock parseYaml expects JSON-compatible YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stringifyYaml(value) {
  return JSON.stringify(value, null, 2);
}

function getFrontMatterInfo(content) {
  const source = String(content);
  const match = source.match(/^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m);
  if (!match || match.index !== 0) {
    return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
  }
  const openingLength = match[0].indexOf("\n") + 1;
  const closingOffset = match[0].lastIndexOf("\n---") + 1;
  return {
    exists: true,
    frontmatter: match[1],
    from: openingLength,
    to: closingOffset,
    contentStart: match[0].length,
  };
}

class TFile {
  constructor(path) {
    this.path = normalizePath(path);
    const segments = this.path.split("/");
    const filename = segments[segments.length - 1] || "";
    const dotIndex = filename.lastIndexOf(".");
    this.basename = dotIndex >= 0 ? filename.slice(0, dotIndex) : filename;
    this.extension = dotIndex >= 0 ? filename.slice(dotIndex + 1) : "";
  }
}

class TFolder {
  constructor(path) {
    this.path = normalizePath(path);
    const segments = this.path.split("/");
    this.name = segments[segments.length - 1] || "";
  }
}

class Vault {}

async function requestUrl() {
  throw new Error("requestUrl is not configured in this unit test.");
}

module.exports = {
  normalizePath,
  getFrontMatterInfo,
  parseYaml,
  stringifyYaml,
  TFile,
  TFolder,
  Vault,
  requestUrl,
};
