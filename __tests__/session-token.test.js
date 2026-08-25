import { UserAuthManager } from "../build/src/utils/user-auth.js";

describe("session tokens", () => {
  it("verifies a token it just issued", async () => {
    const token = await UserAuthManager.createSessionToken("meta_123", 2);
    const decoded = await UserAuthManager.verifySessionToken(token);

    expect(decoded).toEqual({ userId: "meta_123", tokenVersion: 2 });
  });

  it("defaults to version 1 when the claim is absent", async () => {
    const token = await UserAuthManager.createSessionToken("meta_123");
    expect((await UserAuthManager.verifySessionToken(token)).tokenVersion).toBe(1);
  });

  it("rejects a tampered signature", async () => {
    const token = await UserAuthManager.createSessionToken("meta_123");
    const [header, payload] = token.split(".");

    expect(await UserAuthManager.verifySessionToken(`${header}.${payload}.forged`)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    // Assembled at runtime so no JWT-shaped literal is committed.
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const foreign = [
      encode({ alg: "HS256" }),
      encode({ userId: "meta_999", exp: 9999999999 }),
      "0".repeat(43),
    ].join(".");

    expect(await UserAuthManager.verifySessionToken(foreign)).toBeNull();
  });
});

describe("bearer extraction", () => {
  it("reads a well-formed header", () => {
    expect(UserAuthManager.extractBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("ignores other schemes and empty values", () => {
    expect(UserAuthManager.extractBearerToken("Basic abc")).toBeNull();
    expect(UserAuthManager.extractBearerToken("Bearer ")).toBeNull();
    expect(UserAuthManager.extractBearerToken(null)).toBeNull();
  });
});
