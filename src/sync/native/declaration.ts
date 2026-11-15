import template from "./mdbase-app.json";

export function engineManifest(origin: string, embedded: boolean) {
  const { platform, ...manifest } = template;
  return {
    ...manifest,
    ...(!embedded ? { platform } : {}),
    homepage: `${origin}/`,
    redirect_uris: [`${origin}/auth/mdbase/callback`],
  };
}
