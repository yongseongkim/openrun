import test from "node:test";
import assert from "node:assert/strict";
import { parseProvider, parseTimeout } from "../src/config.ts";
import { credentialsFrom } from "../src/credentials.ts";
import { assertAccount, classifyLoginPage, parseAuthResponse, trustedProviderUrl } from "../src/catchtable.ts";
import { publicError } from "../src/errors.ts";
import { validateSession } from "../src/session.ts";

function auth(isLogin: boolean, id = "account-one") {
  return { resultCode: "CT_OK", data: { auth: { isLogin, currentUser: { loggedIn: isLogin, ctUserIdentifier: id } } } };
}

test("authentication requires a positive Catchtable response and an account identifier", () => {
  assert.deepEqual(parseAuthResponse(auth(false, "")), { authenticated: false });
  assert.deepEqual(parseAuthResponse(auth(true)), { authenticated: true, accountId: "account-one" });
  for (const payload of [null, {}, { resultCode: "CT_OK" }, auth(true, ""), { ...auth(true), resultCode: "CT_ERROR" }]) {
    assert.throws(() => parseAuthResponse(payload), { code: "AUTH_CHECK_UNAVAILABLE" });
  }
});

test("inconsistent server flags cannot produce a logged-in result", () => {
  const payload = auth(true);
  payload.data.auth.currentUser.loggedIn = false;
  assert.throws(() => parseAuthResponse(payload), { code: "AUTH_CHECK_UNAVAILABLE" });
});

test("account mismatch fails instead of silently switching accounts", () => {
  assert.doesNotThrow(() => assertAccount({ authenticated: true, accountId: "a" }, "a"));
  assert.throws(() => assertAccount({ authenticated: true, accountId: "b" }, "a"), { code: "ACCOUNT_MISMATCH" });
  assert.throws(() => assertAccount({ authenticated: false }), { code: "NEEDS_LOGIN" });
});

test("credentials retain password whitespace and reject empty values", () => {
  assert.deepEqual(credentialsFrom({ NAVER_USERNAME: " name ", NAVER_PASSWORD: " secret " }, "naver"), {
    username: "name", password: " secret ",
  });
  for (const value of [null, {}, { NAVER_USERNAME: "name", NAVER_PASSWORD: "" }, { NAVER_USERNAME: " ", NAVER_PASSWORD: "secret" }]) {
    assert.throws(() => credentialsFrom(value, "naver"), { code: "CREDENTIALS_MISSING" });
  }
});

test("credentials are restricted to exact HTTPS provider origins", () => {
  assert.equal(trustedProviderUrl("https://nid.naver.com/oauth2.0/authorize", "naver"), true);
  for (const url of ["https://nid.naver.com.evil.example/", "http://nid.naver.com/", "https://nid.naver.com@evil.example", "broken"]) {
    assert.equal(trustedProviderUrl(url, "naver"), false);
  }
  assert.equal(trustedProviderUrl("https://accounts.kakao.com/login", "kakao"), true);
});

test("additional verification and rejected credentials are recognized", () => {
  assert.equal(classifyLoginPage("2단계 인증 요청을 승인해 주세요"), "approval");
  assert.equal(classifyLoginPage("보안문자를 입력해 주세요"), "approval");
  assert.equal(classifyLoginPage("보안 확인을 진행해 주세요"), "approval");
  assert.equal(classifyLoginPage("Enter the characters shown above"), "approval");
  assert.equal(classifyLoginPage("아이디 또는 비밀번호를 확인해 주세요"), "rejected");
  assert.equal(classifyLoginPage("Signing in to 캐치테이블"), "pending");
});

test("raw browser errors never expose entered credentials or URLs", () => {
  const result = publicError(new Error('locator.fill("super-secret-password"): https://example.com?token=private'));
  assert.equal(JSON.stringify(result).includes("super-secret"), false);
  assert.equal(JSON.stringify(result).includes("token="), false);
  assert.equal(result.status, "AUTH_ERROR");
});

test("saved sessions must match the selected provider and have a real identity", () => {
  const session = { version: 1, provider: "naver", accountId: "account-one", savedAt: new Date().toISOString(), storageState: { cookies: [], origins: [] }, sessionStorage: {} };
  assert.equal(validateSession(session, "naver").accountId, "account-one");
  assert.throws(() => validateSession(session, "kakao"), { code: "INVALID_SESSION" });
  assert.throws(() => validateSession({ ...session, accountId: "" }, "naver"), { code: "INVALID_SESSION" });
  assert.throws(() => validateSession({ ...session, storageState: {} }, "naver"), { code: "INVALID_SESSION" });
});

test("configuration defaults to Naver and bounds the approval wait", () => {
  assert.equal(parseProvider(), "naver");
  assert.equal(parseProvider("kakao"), "kakao");
  assert.equal(parseTimeout(), 180_000);
  assert.throws(() => parseProvider("unknown"), { code: "INVALID_CONFIG" });
  for (const timeout of ["0", "-1", "601", "no", "1.5"]) assert.throws(() => parseTimeout(timeout), { code: "INVALID_CONFIG" });
});
