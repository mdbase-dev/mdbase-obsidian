import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { productionIdentity, repin, repinPlan } from "../../scripts/sdk-repin.mjs";
import { publisherIdentity, verifiedPackage, verifyLockIntegrities, verifyProvenance } from "../../scripts/lib/npm-provenance.mjs";

const name = "@mdbase-dev/sdk";
const version = "0.1.0-beta.149";
const release = `v${version}`;
const commit = "a".repeat(40);
const bytes = Buffer.from("fixture SDK, never installed or published");
const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const tarball = `https://registry.npmjs.org/${name}/-/sdk-${version}.tgz`;
const predicateType = "https://slsa.dev/provenance/v1";
const repository = "https://github.com/mdbase-dev/mdbase-connect";
const record = `MDBASE_CONNECT_RELEASE=${release}\nMDBASE_CONNECT_COMMIT=${commit}\n`;
const expected = { name, version, release, commit, integrity };

function bundle(update = () => {}) {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType,
    subject: [{ name: `pkg:npm/%40mdbase-dev/sdk@${version}`, digest: { sha512: createHash("sha512").update(bytes).digest("hex") } }],
    predicate: { buildDefinition: {
      buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
      externalParameters: { workflow: { ref: `refs/tags/${release}`, repository, path: ".github/workflows/publish-sdk-npm.yml" } },
      resolvedDependencies: [{ uri: `git+${repository}@refs/tags/${release}`, digest: { gitCommit: commit } }],
    } },
  };
  update(statement);
  return { dsseEnvelope: { payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(statement)).toString("base64") } };
}

test("production identity requires exact ops record and peeled annotated tag", () => {
  assert.equal(productionIdentity(record, release, commit), commit);
  for (const args of [[record, "latest", commit], [record, release, "b".repeat(40)], [record.replace(release, "v0.1.0-beta.148"), release, commit]]) {
    assert.throws(() => productionIdentity(...args));
  }
});

test("repin migrates only SDK vendor input, preserving other local pins and peers", () => {
  const manifest = { dependencies: { [name]: "file:vendor/old.tgz", "@mdbase-dev/other": "0.0.1", "@mdbase-dev/local": "file:other", "@mdbase-dev/sdk-native": "file:native" }, peerDependencies: { [name]: "*" } };
  const plan = repinPlan([{ path: "package.json", text: JSON.stringify(manifest) }], version);
  const result = JSON.parse(plan.changes[0].text);
  assert.deepEqual(plan.packages, ["@mdbase-dev/other", name]);
  assert.equal(result.dependencies[name], version);
  assert.equal(result.dependencies["@mdbase-dev/local"], "file:other");
  assert.equal(result.peerDependencies[name], "*");
  assert.equal(repinPlan([{ path: "package.json", text: plan.changes[0].text }], version).changes.length, 0);
  assert.throws(() => repinPlan([{ path: "package.json", text: JSON.stringify({ dependencies: { [name]: "https://example.com/sdk" } }) }], version));
});

test("provenance passes exact publisher identity to cryptographic verifier", async () => {
  let verified = false;
  await verifyProvenance(bundle(), expected, async (value, identity) => {
    assert.deepEqual(identity, publisherIdentity(name, release));
    assert.equal(identity.certificateIssuer, "https://token.actions.githubusercontent.com");
    assert.ok(new RegExp(identity.certificateIdentityURI).test(`${repository}/.github/workflows/publish-sdk-npm.yml@refs/tags/${release}`));
    assert.ok(!new RegExp(identity.certificateIdentityURI).test(`${repository}/.github/workflows/publish-npm.yml@refs/tags/${release}`));
    verified = true;
  });
  assert.ok(verified);
  await assert.rejects(verifyProvenance(bundle(), expected, async () => { throw new Error("invalid signature"); }), /invalid signature/);
  const { verify } = await import("sigstore");
  await assert.rejects(verifyProvenance(bundle(), expected, verify));
});

test("rejects wrong repository, workflow, tag, source commit and digest", async () => {
  const mutations = [
    (statement) => { statement.predicate.buildDefinition.externalParameters.workflow.repository += "-impostor"; },
    (statement) => { statement.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/other.yml"; },
    (statement) => { statement.predicate.buildDefinition.externalParameters.workflow.ref = "refs/heads/main"; },
    (statement) => { statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "b".repeat(40); },
    (statement) => { statement.predicate.buildDefinition.resolvedDependencies.push(statement.predicate.buildDefinition.resolvedDependencies[0]); },
    (statement) => { statement.subject[0].digest.sha512 = "00"; },
  ];
  for (const mutate of mutations) await assert.rejects(verifyProvenance(bundle(mutate), expected, async () => {}));
});

test("registry fixture verifies provenance and downloaded tarball, failing closed", async () => {
  const manifest = { name, version, dist: { integrity, tarball, attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/sdk", provenance: { predicateType } } } };
  let missing = false;
  let corrupt = false;
  const fetchMock = mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(options.redirect, "error");
    if (missing) return new Response("missing", { status: 404 });
    if (url === tarball) return new Response(corrupt ? "corrupt" : bytes);
    if (url === manifest.dist.attestations.url) return Response.json({ attestations: [{ predicateType, bundle: bundle() }] });
    return Response.json(manifest);
  });
  try {
    assert.deepEqual(await verifiedPackage(name, version, release, commit, async () => {}), { name, version, integrity, tarball });
    corrupt = true;
    await assert.rejects(verifiedPackage(name, version, release, commit, async () => {}), /integrity mismatch/);
    missing = true;
    await assert.rejects(verifiedPackage(name, version, release, commit, async () => {}), /HTTP 404/);
    missing = false;
    manifest.dist.tarball = "https://attacker.example/sdk.tgz";
    await assert.rejects(verifiedPackage(name, version, release, commit, async () => {}), /Untrusted package registry/);
  } finally {
    fetchMock.mock.restore();
  }
});

test("npm lock must match exact version, tarball and integrity", () => {
  const lock = { lockfileVersion: 3, packages: { "": { dependencies: { [name]: version } }, [`node_modules/${name}`]: { version, integrity, resolved: tarball } } };
  const packages = [{ name, version, integrity, tarball }];
  verifyLockIntegrities(lock, packages);
  for (const field of ["version", "integrity", "resolved"]) {
    const invalid = structuredClone(lock);
    invalid.packages[`node_modules/${name}`][field] = "wrong";
    assert.throws(() => verifyLockIntegrities(invalid, packages));
  }
});

test("missing SDK leaves all manifests and lock untouched", async () => {
  const directory = mkdtempSync(join(tmpdir(), "obsidian-repin-"));
  const original = process.cwd();
  const priorEnvironment = { ...process.env };
  const text = JSON.stringify({ dependencies: { [name]: "file:vendor/old.tgz" } });
  try {
    process.chdir(directory);
    writeFileSync("package.json", text);
    writeFileSync("package-lock.json", "unchanged lock");
    process.env.CONNECT_RELEASE = release;
    process.env.REPIN_INTEGRITIES = join(directory, "integrities.json");
    process.env.GITHUB_OUTPUT = join(directory, "output");
    const run = (command, ...args) => command === "gh" ? JSON.stringify({ content: Buffer.from(record).toString("base64") }) : args[0] === "ls-remote" ? `${commit}\trefs/tags/${release}^{}` : "package.json\0";
    await assert.rejects(repin(async () => { throw new Error("npm registry returned HTTP 404"); }, run), /HTTP 404/);
    assert.equal(readFileSync("package.json", "utf8"), text);
    assert.equal(readFileSync("package-lock.json", "utf8"), "unchanged lock");
    assert.ok(!existsSync("output"));
    await repin(async () => ({ name, version, integrity, tarball }), run);
    assert.equal(JSON.parse(readFileSync("package.json", "utf8")).dependencies[name], version);
    assert.match(readFileSync("output", "utf8"), /changed=true/);
  } finally {
    process.chdir(original);
    process.env = priorEnvironment;
    rmSync(directory, { recursive: true, force: true });
  }
});
