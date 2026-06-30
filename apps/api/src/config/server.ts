const defaultPort = 3000;
const defaultWebOrigin = "http://localhost:5173";

export type ServerConfig = {
  port: number;
  webOrigin: string;
};

export function getServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const portValue = env.PORT ?? `${defaultPort}`;
  const port = Number(portValue);

  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const webOriginValue = env.WEB_ORIGIN ?? defaultWebOrigin;
  let webOrigin: string;

  try {
    webOrigin = new URL(webOriginValue).origin;
  } catch {
    throw new Error("WEB_ORIGIN must be a valid URL");
  }

  return {
    port,
    webOrigin,
  };
}
