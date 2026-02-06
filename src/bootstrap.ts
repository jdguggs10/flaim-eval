import crypto from "node:crypto";
import http from "node:http";
import { writeEnvKey, generatePkce } from "./auth.js";
import open from "open";

const AUTH_BASE_URL =
  process.env.FLAIM_AUTH_BASE_URL || "https://api.flaim.app";
const REDIRECT_URI = "http://localhost:3000/oauth/callback";

async function bootstrap() {
  console.log("=== Flaim Eval — OAuth Bootstrap ===\n");

  // Step 1: Register client via DCR
  console.log("1. Registering eval client...");
  const regRes = await fetch(`${AUTH_BASE_URL}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Flaim Eval Harness",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
    }),
  });

  if (!regRes.ok) {
    console.error("DCR failed:", await regRes.text());
    process.exit(1);
  }

  const { client_id } = (await regRes.json()) as { client_id: string };
  console.log(`   Client registered: ${client_id}`);
  writeEnvKey("FLAIM_CLIENT_ID", client_id);

  // Step 2: Generate PKCE
  const { codeVerifier, codeChallenge } = await generatePkce();

  // Step 3: Build authorize URL
  const state = crypto.randomUUID();
  const authorizeUrl = new URL(`${AUTH_BASE_URL}/auth/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", client_id);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("scope", "mcp:read");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  // Step 4: Start local callback server
  const codePromise = new Promise<string>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url!, `http://localhost:3000`);
      if (url.pathname !== "/oauth/callback") {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Authorization failed</h1><p>You can close this tab.</p>");
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (returnedState !== state) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>State mismatch</h1><p>You can close this tab.</p>");
        server.close();
        reject(new Error("OAuth state mismatch"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<h1>Success!</h1><p>Eval harness authorized. You can close this tab.</p>"
      );
      server.close();
      resolve(code!);
    });

    server.listen(3000, () => {
      console.log("   Callback server listening on port 3000");
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for OAuth callback"));
    }, 120_000);
  });

  // Step 5: Open browser
  console.log("2. Opening browser for consent...");
  await open(authorizeUrl.toString());
  console.log("   Waiting for you to approve in the browser...\n");

  // Step 6: Wait for callback
  const code = await codePromise;
  console.log("3. Got authorization code. Exchanging for tokens...");

  // Step 7: Exchange code for tokens
  const tokenRes = await fetch(`${AUTH_BASE_URL}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
      client_id: client_id,
    }),
  });

  if (!tokenRes.ok) {
    console.error("Token exchange failed:", await tokenRes.text());
    process.exit(1);
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  if (!tokens.refresh_token) {
    console.error("No refresh token returned. Check auth-worker config.");
    process.exit(1);
  }

  writeEnvKey("FLAIM_REFRESH_TOKEN", tokens.refresh_token);

  console.log("\n=== Bootstrap complete ===");
  console.log(`   Access token expires in: ${tokens.expires_in}s`);
  console.log(`   Refresh token saved to: .env`);
  console.log(`   Run scenarios with: npm run eval`);
}

bootstrap().catch((err) => {
  console.error("Bootstrap failed:", err.message);
  process.exit(1);
});
