import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ENV_PATH = path.resolve(import.meta.dirname, "../.env");

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

/**
 * Read refresh token and client_id from .env
 */
export function loadEnvCredentials(): {
  clientId: string;
  refreshToken: string;
  authBaseUrl: string;
} {
  const envContent = fs.readFileSync(ENV_PATH, "utf-8");
  const get = (key: string) =>
    envContent.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1]?.trim() ?? "";

  return {
    clientId: get("FLAIM_CLIENT_ID"),
    refreshToken: get("FLAIM_REFRESH_TOKEN"),
    authBaseUrl: get("FLAIM_AUTH_BASE_URL") || "https://api.flaim.app",
  };
}

/**
 * Write/update a key in .env
 */
export function writeEnvKey(key: string, value: string): void {
  let content = "";
  try {
    content = fs.readFileSync(ENV_PATH, "utf-8");
  } catch {
    // File doesn't exist yet — will create from .env.example
    const examplePath = path.resolve(import.meta.dirname, "../.env.example");
    content = fs.readFileSync(examplePath, "utf-8");
  }

  const regex = new RegExp(`^${key}=.*$`, "m");
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content += `\n${key}=${value}`;
  }
  fs.writeFileSync(ENV_PATH, content);
}

/**
 * Refresh the access token using the stored refresh token.
 * Updates .env with the new refresh token if rotated.
 */
export async function refreshAccessToken(): Promise<string> {
  const { clientId, refreshToken, authBaseUrl } = loadEnvCredentials();

  if (!refreshToken) {
    throw new Error(
      "No refresh token found. Run `npm run bootstrap` first."
    );
  }

  const res = await fetch(`${authBaseUrl}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Token refresh failed (${res.status}): ${body}\nRun \`npm run bootstrap\` to re-authorize.`
    );
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
  };

  // If the server rotated the refresh token, save it
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    writeEnvKey("FLAIM_REFRESH_TOKEN", data.refresh_token);
  }

  return data.access_token;
}

/**
 * Generate PKCE code verifier and challenge (S256).
 */
export async function generatePkce(): Promise<{
  codeVerifier: string;
  codeChallenge: string;
}> {
  const verifierBytes = crypto.randomBytes(32);
  const codeVerifier = verifierBytes
    .toString("base64url")
    .replace(/=/g, "");

  const challengeBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier)
  );
  const codeChallenge = Buffer.from(challengeBuffer)
    .toString("base64url")
    .replace(/=/g, "");

  return { codeVerifier, codeChallenge };
}
