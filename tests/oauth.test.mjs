import test from "node:test";
import assert from "node:assert/strict";
import { readOAuthHash, twitchAuthorizeUrl } from "../dist/lib/oauth.js";

test("OAuth callback requires matching state", () => {
  assert.equal(readOAuthHash("#access_token=secret&state=expected", "expected"), "secret");
  assert.equal(readOAuthHash("#access_token=secret&state=wrong", "expected"), null);
  assert.equal(readOAuthHash("#state=expected", "expected"), null);
});

test("OAuth authorize URL encodes the local callback and scope", () => {
  const url = new URL(twitchAuthorizeUrl("client id", "http://localhost:4173/auth/callback", "state"));
  assert.equal(url.hostname, "id.twitch.tv");
  assert.equal(url.searchParams.get("client_id"), "client id");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:4173/auth/callback");
  assert.equal(url.searchParams.get("scope"), "user:read:follows");
});
