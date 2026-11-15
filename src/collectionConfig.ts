// The collection's mdbase.yaml: loading, first-run setup, type file templates,
// and which vault paths belong to the collection.
import legacyConfig from "./legacyConfig.json" with { type: "json" };
import { normalizePath, parseYaml, stringifyYaml, TFile, Vault } from "obsidian";
import picomatch from "picomatch";
import { portableGlobMatch } from "./pathGlob";
import {
  formatMarkdown,
  isRecord,
  isV03Version,
  parseFrontmatter,
  type CollectionRecord,
  type MdbaseConfig,
} from "./mdbaseCore";

const DEFAULT_CONFIG: MdbaseConfig = {
  spec_version: "0.3.0",
  name: "My mdbase collection",
  description: "Typed markdown collection",
  settings: {
    types_folder: "_types",
    contracts_folder: "_contracts",
    explicit_type_keys: ["type", "types"],
    // v0.3 excludes dot-prefixed paths such as .obsidian, node_modules, and the
    // types and contracts folders by itself.
    exclude: [],
  },
};

/** The v0.2 plugin default, still applied to v0.2 collections without `exclude`. */
// This is collection configuration data, not Obsidian's runtime config path.
const V02_DEFAULT_EXCLUDE = legacyConfig.validationExcludes;

export async function loadMdbaseConfig(vault: Vault): Promise<MdbaseConfig | null> {
  const configFile = vault.getAbstractFileByPath("mdbase.yaml");
  if (!(configFile instanceof TFile)) {
    return null;
  }

  try {
    const raw = await vault.cachedRead(configFile);
    const parsed: unknown = parseYaml(raw);
    if (!isRecord(parsed)) {
      return null;
    }

    const settings = isRecord(parsed.settings) ? parsed.settings : {};
    const runtime = isRecord(parsed.runtime) ? parsed.runtime : undefined;

    return {
      spec_version: typeof parsed.spec_version === "string" ? parsed.spec_version : DEFAULT_CONFIG.spec_version,
      name: typeof parsed.name === "string" ? parsed.name : DEFAULT_CONFIG.name,
      description: typeof parsed.description === "string" ? parsed.description : DEFAULT_CONFIG.description,
      runtime: runtime ? {
        profile_version: typeof runtime.profile_version === "string" ? runtime.profile_version : undefined,
        enabled: typeof runtime.enabled === "boolean" ? runtime.enabled : undefined,
        policy: typeof runtime.policy === "string" ? runtime.policy : undefined,
      } : undefined,
      settings: {
        types_folder:
          typeof settings.types_folder === "string"
            ? settings.types_folder
            : DEFAULT_CONFIG.settings.types_folder,
        contracts_folder:
          typeof settings.contracts_folder === "string"
            ? settings.contracts_folder
            : DEFAULT_CONFIG.settings.contracts_folder,
        explicit_type_keys: Array.isArray(settings.explicit_type_keys)
          ? settings.explicit_type_keys.filter((value): value is string => typeof value === "string")
          : [...DEFAULT_CONFIG.settings.explicit_type_keys],
        ...(typeof settings.default_strict === "boolean" ? { default_strict: settings.default_strict } : {}),
        ...(typeof settings.include_subfolders === "boolean"
          ? { include_subfolders: settings.include_subfolders }
          : {}),
        exclude: Array.isArray(settings.exclude)
          ? settings.exclude.filter((value): value is string => typeof value === "string")
          : isV03Version(parsed.spec_version) ? [] : [...V02_DEFAULT_EXCLUDE],
      },
    };
  } catch {
    return null;
  }
}

export async function ensureCollectionInitialized(vault: Vault, options: { seedNoteType?: boolean } = {}): Promise<{ created: string[] }> {
  const created: string[] = [];

  const mdbaseFile = vault.getAbstractFileByPath("mdbase.yaml");
  if (!(mdbaseFile instanceof TFile)) {
    const configYaml = stringifyYaml(DEFAULT_CONFIG).trimEnd() + "\n";
    await vault.create("mdbase.yaml", configYaml);
    created.push("mdbase.yaml");
  }

  const config = (await loadMdbaseConfig(vault)) ?? DEFAULT_CONFIG;
  const typesFolder = config.settings.types_folder;

  const typesFolderExists = await vault.adapter.exists(typesFolder);
  if (!typesFolderExists) {
    await vault.createFolder(typesFolder);
    created.push(typesFolder);
  }

  const noteTypePath = normalizePath(`${typesFolder}/note.md`);
  const noteTypeExists = await vault.adapter.exists(noteTypePath);
  if (!noteTypeExists && options.seedNoteType !== false) {
    const content = buildTypeTemplate("note", undefined, config.spec_version);
    await vault.create(noteTypePath, content);
    created.push(noteTypePath);
  }

  return { created };
}

export function buildTypeTemplate(
  name: string,
  pathGlob?: string,
  specVersion = DEFAULT_CONFIG.spec_version,
): string {
  if (specVersion.startsWith("0.3.")) {
    const frontmatter: Record<string, unknown> = {
      kind: "mdbase.type",
      name,
      version: 1,
      description: `${name} type`,
      schema: {
        dialect: "json-schema-2020-12",
        value: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          required: ["title"],
          additionalProperties: true,
          properties: {
            title: { type: "string", minLength: 1 },
            tags: { type: "array", items: { type: "string" } },
          },
        },
      },
    };
    if (pathGlob && pathGlob.trim()) {
      frontmatter.match = { path_glob: pathGlob.trim() };
    }
    return `${formatMarkdown(frontmatter, `# ${name}\n\nType definition for ${name}.`)}\n`;
  }
  const frontmatter: Record<string, unknown> = {
    name,
    description: `${name} type`,
    strict: false,
    fields: {
      title: {
        type: "string",
        required: true,
      },
    },
  };

  if (pathGlob && pathGlob.trim().length > 0) {
    frontmatter.match = {
      path_glob: pathGlob.trim(),
    };
  }

  return `${formatMarkdown(frontmatter, `# ${name}\n\nType definition for ${name}.`)}\n`;
}

export async function createTypeDefinition(
  vault: Vault,
  config: MdbaseConfig,
  typeName: string,
  pathGlob?: string,
): Promise<string> {
  const safeName = typeName.trim();
  const typePath = normalizePath(`${config.settings.types_folder}/${safeName}.md`);

  if (await vault.adapter.exists(typePath)) {
    throw new Error(`Type already exists: ${typePath}`);
  }

  const content = buildTypeTemplate(safeName, pathGlob, config.spec_version);
  await vault.create(typePath, content);
  return typePath;
}

export function isExcluded(path: string, config: MdbaseConfig): boolean {
  const normalizedPath = normalizePath(path);
  const typesFolder = normalizePath(config.settings.types_folder);
  if (normalizedPath.startsWith(`${typesFolder}/`) || normalizedPath === typesFolder) return true;

  if (isV03Version(config.spec_version)) {
    // Spec Chapter 02: the contracts folder, built-in exclusions, and
    // portable `settings.exclude` globs.
    const contractsFolder = normalizePath(config.settings.contracts_folder ?? "_contracts");
    if (normalizedPath === contractsFolder || normalizedPath.startsWith(`${contractsFolder}/`)) return true;
    if (normalizedPath.split("/").some((name) => name.startsWith(".") || name === "node_modules")) return true;
    return config.settings.exclude.some((pattern) => portableGlobMatch(pattern, normalizedPath));
  }

  if (config.settings.include_subfolders === false && normalizedPath.includes("/")) {
    return true;
  }

  for (const pattern of config.settings.exclude) {
    const matcher = picomatch(pattern, { dot: true, matchBase: !pattern.includes("/") });
    if (matcher(normalizedPath)) return true;

    if (!pattern.includes("*") && !pattern.includes("?") && !pattern.includes("/") && normalizedPath.startsWith(`${pattern}/`)) {
      return true;
    }
  }

  return false;
}

/** Parsed frontmatter for every record the collection validates. Unparseable notes are skipped. */
export async function readCollectionRecords(vault: Vault, config: MdbaseConfig): Promise<CollectionRecord[]> {
  const records: CollectionRecord[] = [];
  let yieldedAt = performance.now();
  for (const file of vault.getMarkdownFiles()) {
    // cachedRead can resolve in a microtask: awaiting it alone does not let the
    // editor paint or process input. Yield by time, not once per tiny file.
    if (performance.now() - yieldedAt >= 8) {
      await new Promise(resolve => window.setTimeout(resolve, 0));
      yieldedAt = performance.now();
    }
    if (isExcluded(file.path, config)) continue;
    const parsed = parseFrontmatter(await vault.cachedRead(file));
    if (parsed.error) continue;
    records.push({ path: file.path, frontmatter: parsed.frontmatter });
  }
  return records;
}
