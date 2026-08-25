import {
  isPinConfigured,
  createGateToken,
  verifyGateToken,
  hasGateAccess,
} from "../build/src/utils/access-pin.js";

describe("PIN configuration", () => {
  afterEach(() => {
    delete process.env.ACCESS_PIN;
    delete process.env.ACCESS_PIN_HASH;
  });

  it("is off when neither variable is set", () => {
    expect(isPinConfigured()).toBe(false);
  });

  it("is on with a plain PIN", () => {
    process.env.ACCESS_PIN = "1234";
    expect(isPinConfigured()).toBe(true);
  });

  it("is on with a hashed PIN", () => {
    process.env.ACCESS_PIN_HASH = "a".repeat(64);
    expect(isPinConfigured()).toBe(true);
  });
});

describe("gate tokens", () => {
  it("verifies a token it issued", async () => {
    expect(await verifyGateToken(await createGateToken())).toBe(true);
  });

  it("rejects junk and missing tokens", async () => {
    expect(await verifyGateToken("not-a-token")).toBe(false);
    expect(await verifyGateToken(null)).toBe(false);
  });

  it("rejects a session token used as a gate token", async () => {
    const { UserAuthManager } = await import("../build/src/utils/user-auth.js");
    const sessionToken = await UserAuthManager.createSessionToken("meta_1");

    expect(await verifyGateToken(sessionToken)).toBe(false);
  });
});

describe("hasGateAccess", () => {
  afterEach(() => {
    delete process.env.ACCESS_PIN;
  });

  it("lets everyone through when no PIN is configured", async () => {
    expect(await hasGateAccess(null)).toBe(true);
  });

  it("requires a valid gate token once a PIN is configured", async () => {
    process.env.ACCESS_PIN = "1234";

    expect(await hasGateAccess(null)).toBe(false);
    expect(await hasGateAccess(await createGateToken())).toBe(true);
  });
});
