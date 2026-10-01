import { App, Modal, TFile, requestUrl, parseYaml } from "obsidian";

const CATALOG_URL = "https://mdbase.dev/contracts/catalog.json";
const LOCK = "mdbase.lock.yaml";
const JOURNAL = ".mdbase/obsidian-pack-install.json";
interface Resource { kind: "contract" | "type" | "schema"; mode: "managed" | "seed"; source: string; target: string; digest: string }
export interface CatalogPack {
  id: string; version: string; digest: string; provision: string; resource_count: number;
  display: { name: string; summary: string };
  installation: { visibility: string; recommendation: string; primary_type: string | null; caution?: string };
}
// The published wire field is named document.
// eslint-disable-next-line obsidianmd/prefer-active-doc -- Preserve the published protocol property name.
interface Provision { manifest: { kind: string; id: string; version: string; resources: Resource[] }; resources: { source: string; document: string }[] }
interface Receipt { id: string; version: string; digest: string; installed_by: string; resources: Resource[] }
interface PackLock { kind: string; lock_version: number; packs: Receipt[] }
export interface PackPlan { pack: CatalogPack; provision: Provision; lockBefore: string | null; lockAfter: string; files: { path: string; before: string | null; after: string; action: string }[] }

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid contract catalog or type pack.");
  return value as Record<string, unknown>;
}
function text(value: unknown): string { if (typeof value !== "string" || !value) throw new Error("Missing catalog field."); return value; }
function digestString(value: unknown): string { const result = text(value); if (!/^sha256:[a-f0-9]{64}$/.test(result)) throw new Error("Invalid pack digest."); return result; }
export function safePackPath(value: unknown): string {
  const path = text(value);
  if (path.includes("\\") || path.includes(":") || Array.from(path).some(char => char.charCodeAt(0) < 32) || path.split("/").some(segment => !segment || segment === "." || segment === ".." || segment.startsWith("."))) throw new Error(`Unsafe pack path: ${path}`);
  return path;
}
export async function sha256(bytes: ArrayBuffer | string): Promise<string> {
  const input = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", input))).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
function artifact(value: unknown): string {
  const url = new URL(text(value), CATALOG_URL);
  if (url.origin !== new URL(CATALOG_URL).origin || !url.pathname.startsWith("/contracts/")) throw new Error("Pack artifacts must come from the first-party contract catalog.");
  return url.href;
}
export async function loadCatalog(): Promise<CatalogPack[]> {
  const response = await requestUrl({ url: CATALOG_URL, throw: false });
  if (response.status !== 200) throw new Error(`Catalog unavailable (${response.status}). Your vault is unchanged. Try again when online.`);
  if (response.arrayBuffer.byteLength > 1024 * 1024) throw new Error("Contract catalog is too large.");
  const catalog = record(response.json);
  if (catalog.catalog_version !== 2 || !Array.isArray(catalog.packs)) throw new Error("Unsupported contract catalog.");
  return catalog.packs.map(value => {
    const pack = record(value);
    const display = record(pack.display);
    const installation = record(pack.installation);
    if (!Number.isInteger(pack.resource_count) || Number(pack.resource_count) < 1 || Number(pack.resource_count) > 100) throw new Error("Invalid pack resource count.");
    return { id: text(pack.id), version: text(pack.version), digest: digestString(pack.digest), provision: artifact(pack.provision), resource_count: Number(pack.resource_count),
      display: { name: text(display.name), summary: text(display.summary) },
      installation: { visibility: text(installation.visibility), recommendation: text(installation.recommendation), primary_type: installation.primary_type == null ? null : text(installation.primary_type), ...(typeof installation.caution === "string" ? { caution: installation.caution } : {}) } };
  });
}
async function read(app: App, path: string): Promise<string | null> {
  const file = app.vault.getAbstractFileByPath(path);
  if (file && !(file instanceof TFile)) throw new Error(`A folder occupies ${path}.`);
  return file instanceof TFile ? app.vault.read(file) : null;
}
async function folder(app: App, path: string): Promise<void> {
  const segments = path.split("/"); segments.pop();
  let current = "";
  for (const segment of segments) { current = current ? `${current}/${segment}` : segment; if (!app.vault.getAbstractFileByPath(current)) await app.vault.createFolder(current); }
}
export async function preparePack(app: App, pack: CatalogPack): Promise<PackPlan> {
  const response = await requestUrl({ url: pack.provision, throw: false });
  if (response.status !== 200) throw new Error(`Type pack unavailable (${response.status}).`);
  if (response.arrayBuffer.byteLength > 1024 * 1024 || await sha256(response.arrayBuffer) !== pack.digest) throw new Error("The type pack does not match its catalog digest.");
  return planPack(app, pack, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.arrayBuffer)));
}
export async function planPack(app: App, pack: CatalogPack, value: unknown): Promise<PackPlan> {
  const provision = record(value);
  const manifest = record(provision.manifest);
  if (manifest.kind !== "mdbase.type-pack" || manifest.id !== pack.id || manifest.version !== pack.version
    || !Array.isArray(manifest.resources) || manifest.resources.length !== pack.resource_count || !Array.isArray(provision.resources)
    || provision.resources.length !== manifest.resources.length) throw new Error("The type-pack identity or resources do not match the catalog.");
  const docs = new Map<string, string>();
  for (const value of provision.resources) {
    const document = record(value); const source = safePackPath(document.source);
    if (docs.has(source)) throw new Error("Duplicate pack source.");
    const body = text(document.document);
    if (new TextEncoder().encode(body).byteLength > 262144) throw new Error("Pack resource is too large.");
    docs.set(source, body);
  }
  const targets = new Set<string>();
  const files: PackPlan["files"] = [];
  const resources: Resource[] = [];
  const lockBefore = await read(app, LOCK);
  const lock: PackLock = lockBefore ? parseYaml(lockBefore) : { kind: "mdbase.type-pack-lock", lock_version: 1, packs: [] };
  if (lock.kind !== "mdbase.type-pack-lock" || lock.lock_version !== 1 || !Array.isArray(lock.packs)) throw new Error("Existing pack lock cannot be read safely.");
  const existing = lock.packs.find(receipt => receipt.id === pack.id);
  const manifestDigest = await sha256(canonical(manifest));
  if (existing && (existing.version !== pack.version || existing.digest !== manifestDigest)) throw new Error("This pack is already installed at another revision. Upgrade it with mdbase editor; Obsidian currently supports fresh installs and same-version repair only.");
  for (const value of manifest.resources) {
    const resource = record(value);
    const source = safePackPath(resource.source); const target = safePackPath(resource.target);
    if (!["contract", "type", "schema"].includes(String(resource.kind)) || !["managed", "seed"].includes(String(resource.mode)) || targets.has(target)) throw new Error("Invalid pack resource or duplicate target.");
    // Packs may never write notes, configuration, secrets or another plugin's files.
    const prefix = resource.kind === "type" ? "_types/" : resource.kind === "contract" ? "_contracts/" : "schemas/";
    if (!target.startsWith(prefix)) throw new Error(`Unsupported pack target ${target}. Default definition folders are required.`);
    targets.add(target);
    const after = docs.get(source); const digest = digestString(resource.digest);
    if (!after || await sha256(after) !== digest) throw new Error(`Resource digest mismatch: ${source}`);
    if (lock.packs.some(receipt => receipt.id !== pack.id && receipt.resources.some(prior => prior.mode === "managed" && prior.target === target))) throw new Error(`${target} belongs to another installed pack.`);
    const before = await read(app, target);
    const prior = existing?.resources.find(prior => prior.target === target);
    if (resource.mode === "managed" && before !== null && await sha256(before) !== digest) throw new Error(`${target} already exists with different contents. Nothing was overwritten.`);
    const action = before === null && !(resource.mode === "seed" && prior) ? "create" : resource.mode === "seed" ? "preserve" : "unchanged";
    files.push({ path: target, before, after, action });
    resources.push({ kind: resource.kind as Resource["kind"], mode: resource.mode as Resource["mode"], source, target, digest });
  }
  const receipt: Receipt = { id: pack.id, version: pack.version, digest: manifestDigest, installed_by: existing?.installed_by ?? "mdbase-obsidian", resources };
  const lockAfter = `${JSON.stringify({ ...lock, packs: [...lock.packs.filter(receipt => receipt.id !== pack.id), receipt].sort((a, b) => a.id.localeCompare(b.id)) }, null, 2)}\n`;
  return { pack, provision: value as Provision, lockBefore, lockAfter, files };
}

/** Durable rollback journal. Never roll back a file someone changed after install. */
export async function recoverPackInstall(app: App): Promise<void> {
  if (!await app.vault.adapter.exists(JOURNAL)) return;
  const journal = record(JSON.parse(await app.vault.adapter.read(JOURNAL)));
  if (!Array.isArray(journal.created)) throw new Error("Invalid pack recovery journal.");
  if (await read(app, LOCK) === journal.lockAfter) { await app.vault.adapter.remove(JOURNAL); return; }
  for (const value of [...journal.created].reverse()) {
    const item = record(value); const path = safePackPath(item.path);
    const file = app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile && await sha256(await app.vault.read(file)) === item.digest) await app.fileManager.trashFile(file);
    else if (file) throw new Error(`Pack recovery stopped: ${path} changed. Your edits and the journal were preserved.`);
  }
  await app.vault.adapter.remove(JOURNAL);
}

const activeInstalls = new WeakSet<App>();
export async function applyPack(app: App, plan: PackPlan, assertWritable: () => void, onProgress?: (completed: number, total: number) => void): Promise<void> {
  if (activeInstalls.has(app)) throw new Error("Another contract pack is installing. Wait for it to finish.");
  activeInstalls.add(app);
  try { await applyPackExclusive(app, plan, assertWritable, onProgress); }
  finally { activeInstalls.delete(app); }
}

async function applyPackExclusive(app: App, plan: PackPlan, assertWritable: () => void, onProgress?: (completed: number, total: number) => void): Promise<void> {
  assertWritable();
  if (await app.vault.adapter.exists(JOURNAL)) throw new Error("Recover the previous pack installation before trying again.");
  if (await read(app, LOCK) !== plan.lockBefore) throw new Error("Pack lock changed. Review again.");
  for (const file of plan.files) if (await read(app, file.path) !== file.before) throw new Error(`${file.path} changed. Review again.`);
  await folder(app, JOURNAL);
  const journal = { lockAfter: plan.lockAfter, created: [] as { path: string; digest: string }[] };
  await app.vault.adapter.write(JOURNAL, JSON.stringify(journal));
  try {
    const creates = plan.files.filter(file => file.action === "create");
    onProgress?.(0, creates.length);
    for (const [index, file] of creates.entries()) {
      assertWritable();
      await folder(app, file.path);
      if (await read(app, file.path) !== null) throw new Error(`${file.path} appeared during installation.`);
      // Journal the intent before creating so process termination is recoverable.
      journal.created.push({ path: file.path, digest: await sha256(file.after) });
      await app.vault.adapter.write(JOURNAL, JSON.stringify(journal));
      await app.vault.create(file.path, file.after);
      if (await read(app, file.path) !== file.after) throw new Error(`${file.path} changed during installation. Recovery will preserve competing edits.`);
      onProgress?.(index + 1, creates.length);
    }
    assertWritable();
    const lock = app.vault.getAbstractFileByPath(LOCK);
    if (lock instanceof TFile) await app.vault.process(lock, current => { if (current !== plan.lockBefore) throw new Error("Pack lock changed during installation."); return plan.lockAfter; });
    else await app.vault.create(LOCK, plan.lockAfter);
    await app.vault.adapter.remove(JOURNAL);
  } catch (error) { await recoverPackInstall(app); throw error; }
}

export class ContractCatalogModal extends Modal {
  private dismissed = false;
  constructor(app: App, private readonly assertWritable: () => void, private readonly installed: (primaryType: string | null) => Promise<void>) { super(app); }
  onOpen(): void { this.titleEl.setText("Ready-made types · mdbase-contracts"); void this.load(); }
  private async load(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: "Loading first-party contract catalog…" });
    try {
      const packs = await loadCatalog();
      if (this.dismissed) return;
      this.contentEl.empty();
      this.contentEl.createEl("p", { text: "Install standard application contracts plus editable starter types. Nothing grants applications access to your vault. Existing starter types are preserved." });
      const advanced = this.contentEl.createEl("details"); advanced.createEl("summary", { text: "Advanced and integration packs" });
      for (const pack of packs.filter(pack => pack.installation.visibility !== "hidden")) {
        const row = (pack.installation.visibility === "default" ? this.contentEl : advanced).createDiv({ cls: "mdbase-editor-section" });
        row.createEl("h3", { text: pack.display.name }); row.createDiv({ cls: "mdbase-muted", text: `Version ${pack.version}` }); row.createEl("p", { text: pack.display.summary });
        if (pack.installation.caution) row.createEl("p", { text: pack.installation.caution });
        const review = row.createEl("button", { text: "Review installation" });
        const detail = row.createDiv();
        review.onclick = () => {
          review.disabled = true;
          void preparePack(this.app, pack).then(plan => {
            if (this.dismissed) return;
            detail.empty();
            for (const file of plan.files) detail.createDiv({ text: `${file.action} · ${file.path}` });
            const apply = detail.createEl("button", { text: "Install reviewed pack", cls: "mod-cta" });
            apply.onclick = () => {
              apply.disabled = true;
              void applyPack(this.app, plan, this.assertWritable, (completed, total) => { apply.textContent = `Installing ${completed} of ${total} files…`; }).then(async () => {
                await this.installed(pack.installation.primary_type); this.close();
              }).catch(error => { detail.createDiv({ cls: "mdbase-inline-error", text: String(error) }); apply.disabled = false; apply.textContent = "Install reviewed pack"; });
            };
          }).catch(error => { detail.createDiv({ cls: "mdbase-inline-error", text: String(error) }); }).finally(() => { review.disabled = false; });
        };
      }
    } catch (error) {
      if (this.dismissed) return;
      this.contentEl.empty(); this.contentEl.createEl("p", { cls: "mdbase-inline-error", text: String(error) });
      this.contentEl.createEl("button", { text: "Retry catalog" }).onclick = () => void this.load();
    }
  }
  onClose(): void { this.dismissed = true; }
}
