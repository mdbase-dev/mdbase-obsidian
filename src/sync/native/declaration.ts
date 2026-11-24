import template from "./mdbase-app.json";

export type EngineEnvironment = "lab" | "staging" | "production";

export function engineManifest(origin: string, embedded: boolean, environment: EngineEnvironment = "production") {
  const { platform, ...manifest } = template;
  if (embedded && origin.startsWith("capacitor://")) {
    // Connect requires homepage/redirect_uris to use HTTPS or loopback HTTP;
    // Capacitor iOS origins register under installation_origins.<env>.mobile.
    return {
      ...manifest,
      homepage: "http://localhost/",
      redirect_uris: ["http://localhost/auth/mdbase/callback"],
      installation_origins: { [environment]: { mobile: [origin] } },
    };
  }
  return {
    ...manifest,
    ...(!embedded ? { platform } : {}),
    homepage: `${origin}/`,
    redirect_uris: [`${origin}/auth/mdbase/callback`],
  };
}
