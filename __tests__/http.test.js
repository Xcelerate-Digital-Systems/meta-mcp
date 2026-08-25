import { escapeHtml, parseCookies, buildCookie, isSameOrigin } from "../build/src/utils/http.js";

describe("escapeHtml", () => {
  it("neutralises markup in interpolated values", () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"
    );
  });

  it("escapes attribute-breaking characters", () => {
    expect(escapeHtml(`" onload='steal()`)).toBe("&quot; onload=&#39;steal()");
  });

  it("renders nullish values as an empty string", () => {
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(null)).toBe("");
  });
});

describe("parseCookies", () => {
  it("returns an empty jar for a missing header", () => {
    expect(parseCookies(undefined)).toEqual({});
  });

  it("keeps values that themselves contain '='", () => {
    const jar = parseCookies("session_token=aaa.bbb==; other=1");
    expect(jar.session_token).toBe("aaa.bbb==");
    expect(jar.other).toBe("1");
  });

  it("trims surrounding whitespace", () => {
    expect(parseCookies("  a=1 ;  b=2  ")).toEqual({ a: "1", b: "2" });
  });
});

describe("buildCookie", () => {
  it("marks cookies HttpOnly and Secure over HTTPS", () => {
    const cookie = buildCookie("session_token", "abc", { maxAge: 60, secure: true });
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=60");
  });

  it("omits Secure when the request is not over HTTPS", () => {
    expect(buildCookie("a", "b", { maxAge: 60, secure: false })).not.toContain("Secure");
  });
});

describe("isSameOrigin", () => {
  const request = (headers) => ({ headers });

  it("accepts a matching origin", () => {
    expect(isSameOrigin(request({ origin: "https://example.com", host: "example.com" }))).toBe(true);
  });

  it("rejects a foreign origin", () => {
    expect(isSameOrigin(request({ origin: "https://evil.test", host: "example.com" }))).toBe(false);
  });

  it("rejects a request with no origin or referer", () => {
    expect(isSameOrigin(request({ host: "example.com" }))).toBe(false);
  });
});
