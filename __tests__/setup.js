// Deterministic environment for the unit tests. Real secrets never appear here.
process.env.JWT_SECRET =
  process.env.JWT_SECRET || "test-secret-value-that-is-long-enough-for-hs256-abcdef";
process.env.NODE_ENV = "test";
