import { describe, expect, it } from "vitest";
import mongoose, { Schema } from "mongoose";
import { assertNoOperatorInjection } from "../src/store/mongo.js";

/**
 * Regression tests for the production authentication failure:
 *
 *   Cast to Boolean failed for value "{ '$ne': true }" (type Object) at path "revoked"
 *
 * The cause was `mongoose.set("sanitizeFilter", true)` in `MongoStore.connect()`.
 * `sanitizeFilter` rewrites any filter value containing a `$` key into `{ $eq: <value> }`,
 * so `{ revoked: { $ne: true } }` became `{ revoked: { $eq: { $ne: true } } }` and the
 * object could not be cast onto the Boolean path.
 *
 * These tests assert the query shape that broke in production now casts cleanly.
 */
function booleanSessionSchema(): Schema {
  return new Schema(
    {
      _id: { type: String },
      userId: { type: String },
      lastSeenAt: Date,
      revoked: { type: Boolean, default: false },
      expiresAt: Date,
    },
    { timestamps: { createdAt: true, updatedAt: false }, collection: "sessions" },
  );
}

/** Builds a fresh model so tests never share cached mongoose state. */
function freshModel(name: string): mongoose.Model<unknown> {
  const models = mongoose.models as unknown as Record<string, unknown>;
  delete models[name];
  const connModels = mongoose.connection.models as unknown as Record<string, unknown>;
  delete connModels[name];
  return mongoose.model(name, booleanSessionSchema()) as unknown as mongoose.Model<unknown>;
}

const asQuery = (m: mongoose.Model<unknown>, filter: Record<string, unknown>) => m.findOne(filter);

describe("MongoDB Boolean filter casting (production regression)", () => {
  it("does NOT set sanitizeFilter globally", () => {
    // The setting itself must be off, otherwise every operator filter below is corrupted.
    // (connect() no longer sets it; it must never be enabled process-wide.)
    expect(mongoose.get("sanitizeFilter")).toBeFalsy();
  });

  it("casts { revoked: { $ne: true } } on the Boolean path without error", () => {
    const M = freshModel("CastCheckSession");
    // Sanity: the raw operator DOES break the cast when sanitizeFilter is applied, which is
    // exactly what happened in production.
    const broken = { revoked: { $eq: { $ne: true } } };
    expect(() => M.schema.path("revoked").cast(broken.revoked)).toThrow(/Cast to Boolean failed/);

    // The real query shape used by sessions.resolve() casts fine.
    expect(() => asQuery(M, { _id: "abc", revoked: { $ne: true } }).cast(M)).not.toThrow();
  });

  it("preserves the { $ne: true } operator instead of wrapping it in $eq", () => {
    const M = freshModel("ShapeCheckSession");
    const q = asQuery(M, { _id: "abc", revoked: { $ne: true } });
    const filter = q.getFilter() as Record<string, unknown>;
    expect(filter["revoked"]).toEqual({ $ne: true });
  });

  it("casts { isDeleted: { $ne: true } } for soft-deleted users", () => {
    const models = mongoose.models as unknown as Record<string, unknown>;
    delete models["CastUser"];
    const User = mongoose.model("CastUser", new Schema({ _id: String, isDeleted: { type: Boolean, default: false } }, { collection: "users" }));
    expect(() => User.findOne({ _id: "x", isDeleted: { $ne: true } }).cast(User)).not.toThrow();
  });

  it("keeps other legitimate operator filters castable", () => {
    const M = freshModel("OtherOperatorsSession");
    const now = new Date();
    expect(() => asQuery(M, { revoked: { $ne: true }, expiresAt: { $gt: now } }).cast(M)).not.toThrow();
  });

  it("explicit Boolean equality also casts (used for new writes)", () => {
    const M = freshModel("EqualitySession");
    expect(() => asQuery(M, { _id: "abc", revoked: false }).cast(M)).not.toThrow();
  });
});

describe("operator-injection guard", () => {
  it("accepts scalars and operators", () => {
    expect(() => assertNoOperatorInjection("abc", "id")).not.toThrow();
    expect(() => assertNoOperatorInjection(42, "n")).not.toThrow();
    expect(() => assertNoOperatorInjection(true, "b")).not.toThrow();
    expect(() => assertNoOperatorInjection(null, "x")).not.toThrow();
    expect(() => assertNoOperatorInjection(undefined, "x")).not.toThrow();
  });

  it("refuses object values that could act as MongoDB operators", () => {
    expect(() => assertNoOperatorInjection({ $ne: null }, "id")).toThrow(/object values are not allowed/);
    expect(() => assertNoOperatorInjection({ $gt: "" }, "id")).toThrow();
    expect(() => assertNoOperatorInjection([{ $ne: 1 }], "id")).toThrow();
  });
});