export interface AdoptionRenamePlan {
  renames: Array<{ from: string; to: string }>;
  manual: string[][];
  revision: string;
}

export function portablePathKey(path: string): string {
  // Match the provider: NFC, lowercase each Unicode scalar, then NFC again.
  return [...path.normalize("NFC")].map(char => char.toLowerCase()).join("").normalize("NFC");
}

export function findAdoptionPathConflicts(paths: Iterable<string>): string[][] {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const key = portablePathKey(path);
    const group = groups.get(key) ?? [];
    group.push(path);
    groups.set(key, group);
  }
  return [...groups.values()].filter(group => group.length > 1);
}

export function proposeAdoptionRenames(
  conflicts: string[][],
  occupiedPaths: Iterable<string>,
  resources: ReadonlySet<string>,
): Omit<AdoptionRenamePlan, "revision"> {
  const occupied = new Set([...occupiedPaths].map(portablePathKey));
  const renames: AdoptionRenamePlan["renames"] = [];
  const manual: string[][] = [];
  for (const group of [...conflicts].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) {
    const paths = [...group].sort();
    // Collection resources can have non-Obsidian references. Do not rewrite
    // their namespace automatically, or mistake duplicate enumeration for files.
    if (paths.some(path => resources.has(path)) || new Set(paths).size !== paths.length) {
      manual.push(paths);
      continue;
    }
    for (const from of paths.slice(1)) {
      const slash = from.lastIndexOf("/");
      const dot = from.lastIndexOf(".");
      const extension = dot > slash + 1 ? from.slice(dot) : "";
      const stem = extension ? from.slice(0, -extension.length) : from;
      let suffix = 2;
      let to: string;
      do { to = `${stem} (${suffix++})${extension}`; } while (occupied.has(portablePathKey(to)));
      occupied.add(portablePathKey(to));
      renames.push({ from, to });
    }
  }
  return { renames, manual };
}
