// Browser origins allowed to call the API. Production (any NODE_ENV other than development/local) keeps the single FRONTEND_ORIGIN.
// In local development only, the three local web apps are allowed by an exact list. No wildcards, no patterns, no environment-supplied list.
export const LOCAL_WEB_ORIGINS: readonly string[] = Object.freeze([
  "http://127.0.0.1:5173",  // doctor web (Vite)
  "http://127.0.0.1:5174",  // admin web (Vite)
  "http://localhost:8081",  // patient app web preview (Expo)
  "http://127.0.0.1:8081",  // patient app web preview (Expo, loopback IP)
]);
export function localMode(env: NodeJS.ProcessEnv): boolean { return env.NODE_ENV === "development" || env.NODE_ENV === "local"; }
export function allowedOrigins(env: NodeJS.ProcessEnv): readonly string[] {
  const single = env.FRONTEND_ORIGIN || "http://localhost:5173";
  return localMode(env) ? [...new Set([single, ...LOCAL_WEB_ORIGINS])] : [single];
}
/** Options for the cors package: a listed origin is echoed back; anything else gets no CORS headers. */
export function corsOriginCheck(env: NodeJS.ProcessEnv = process.env) {
  return (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
    if (origin === undefined) { callback(null, false); return; }
    callback(null, allowedOrigins(env).includes(origin));
  };
}
