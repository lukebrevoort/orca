const defaultPort = 3000;
const defaultWebOrigin = "http://localhost:5173";

export type ServerConfig = {
  port: number;
  webOrigin: string;
};

export function getServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const portValue = env.PORT ?? `${defaultPort}`;
  const port = Number(portValue);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("PORT must be a positive integer");
  }

  const webOrigin = env.WEB_ORIGIN ?? defaultWebOrigin;

  try {
    new URL(webOrigin);
  } catch {
    throw new Error("WEB_ORIGIN must be a valid URL");
  }

  return {
    port,
    webOrigin,
  };
}
