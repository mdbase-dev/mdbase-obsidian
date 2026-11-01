import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const repository = "https://github.com/mdbase-dev/mdbase-connect";
const predicateType = "https://slsa.dev/provenance/v1";

export function publisherIdentity(name, release) {
  const workflow = name === "@mdbase-dev/sdk" ? "publish-sdk-npm.yml" : "publish-npm.yml";
  const path = `.github/workflows/${workflow}`;
  return {
    path,
    certificateIssuer: "https://token.actions.githubusercontent.com",
    certificateIdentityURI: `^${`${repository}/${path}@refs/tags/${release}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    ctLogThreshold: 1,
    tlogThreshold: 1,
    retry: 0,
  };
}

export async function verifyProvenance(
  bundle,
  { name, version, integrity, release, commit },
  verify,
) {
  const identity = publisherIdentity(name, release);
  await verify(bundle, identity);
  assert.equal(bundle.dsseEnvelope.payloadType, "application/vnd.in-toto+json");
  const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64"));
  assert.equal(statement._type, "https://in-toto.io/Statement/v1");
  assert.equal(statement.predicateType, predicateType);
  assert.match(integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  assert.deepEqual(statement.subject, [
    {
      name: `pkg:npm/${name.replace("@", "%40")}@${version}`,
      digest: { sha512: Buffer.from(integrity.slice(7), "base64").toString("hex") },
    },
  ]);
  const definition = statement.predicate.buildDefinition;
  assert.equal(
    definition.buildType,
    "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
  );
  assert.deepEqual(definition.externalParameters.workflow, {
    ref: `refs/tags/${release}`,
    repository,
    path: identity.path,
  });
  const sources = definition.resolvedDependencies.filter(
    (source) => source.uri === `git+${repository}@refs/tags/${release}`,
  );
  assert.equal(sources.length, 1, "Missing or ambiguous source provenance");
  assert.equal(
    sources[0].digest.gitCommit,
    commit,
    "Provenance does not match verified production commit",
  );
}

async function registryResponse(url) {
  const parsed = new URL(url);
  assert.equal(parsed.origin, "https://registry.npmjs.org", "Untrusted package registry URL");
  assert.equal(parsed.username + parsed.password + parsed.hash, "");
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, `npm registry returned HTTP ${response.status}`);
  return response;
}

export async function verifiedPackage(name, version, release, commit, verifySignature) {
  const manifest = await (
    await registryResponse(`https://registry.npmjs.org/${name.replace("/", "%2F")}/${version}`)
  ).json();
  assert.equal(manifest.name, name);
  assert.equal(manifest.version, version);
  const { integrity, tarball, attestations } = manifest.dist;
  assert.equal(
    attestations?.provenance?.predicateType,
    predicateType,
    `Missing provenance for ${name}`,
  );
  const envelope = await (await registryResponse(attestations.url)).json();
  const candidates = envelope.attestations.filter((item) => item.predicateType === predicateType);
  assert.equal(candidates.length, 1, `Missing or ambiguous provenance for ${name}`);
  const verify = verifySignature ?? (await import("sigstore")).verify;
  await verifyProvenance(
    candidates[0].bundle,
    { name, version, integrity, release, commit },
    verify,
  );
  const bytes = Buffer.from(await (await registryResponse(tarball)).arrayBuffer());
  assert.equal(
    `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    integrity,
    `Tarball integrity mismatch for ${name}`,
  );
  return { name, version, integrity, tarball };
}

export function verifyLockIntegrities(lock, packages) {
  for (const pkg of packages) {
    assert.equal(lock.lockfileVersion, 3, "Expected npm lockfile v3");
    const resolution = lock.packages?.[`node_modules/${pkg.name}`];
    assert.equal(resolution?.version, pkg.version, `Lockfile version mismatch for ${pkg.name}`);
    assert.equal(lock.packages?.[""]?.dependencies?.[pkg.name], pkg.version);
    assert.equal(
      resolution?.integrity,
      pkg.integrity,
      `Lockfile integrity mismatch for ${pkg.name}`,
    );
    assert.ok(
      resolution.resolved === pkg.tarball && !resolution.link,
      `Lockfile tarball mismatch for ${pkg.name}`,
    );
  }
}
