const AUTH_ENDPOINT = "https://id.twitch.tv/oauth2/authorize";
export const OAUTH_STATE_KEY = "twilight.oauth.state";

export function createOAuthState(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function twitchAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "token",
    scope: "user:read:follows",
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export function readOAuthHash(hash: string, expectedState: string | null): string | null {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const token = params.get("access_token");
  const returnedState = params.get("state");
  if (!token || !expectedState || returnedState !== expectedState) return null;
  return token;
}
