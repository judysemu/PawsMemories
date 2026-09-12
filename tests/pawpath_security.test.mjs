import test from "node:test";
import assert from "node:assert/strict";
import { LocationSettingsSchema, PresenceSchema, UserReportSchema, HazardSchema, parseId } from "../server/pawpath/schemas.ts";
import { mapCoordinate, publicCoordinate, PRESENCE_TTL_MINUTES } from "../server/pawpath/privacy.ts";
import { MIGRATIONS, CURRENT_SCHEMA_VERSION } from "../server/migrations/runner.ts";
import express from "express";
import request from "supertest";
import { requireAuth } from "../auth.ts";
import { createPawPathRouter } from "../server/pawpath/routes.ts";

test("location sharing defaults must be explicit and private is accepted", () => {
  assert.equal(LocationSettingsSchema.parse({ visibility: "private" }).sharePreciseWithFriends, false);
  assert.equal(LocationSettingsSchema.safeParse({ visibility: "everyone" }).success, false);
});

test("presence rejects impossible coordinates and unknown fields", () => {
  assert.equal(PresenceSchema.safeParse({ latitude: 91, longitude: 0 }).success, false);
  assert.equal(PresenceSchema.safeParse({ latitude: 40, longitude: -105, secret: "leak" }).success, false);
  assert.equal(PresenceSchema.safeParse({ latitude: 40, longitude: -105, accuracyMeters: 9 }).success, true);
});

test("community coordinates are coarsened while opted-in friend coordinates remain exact", () => {
  const coordinate = 39.7392371;
  assert.notEqual(publicCoordinate(coordinate), coordinate);
  assert.equal(mapCoordinate(coordinate, true), coordinate);
  assert.equal(mapCoordinate(coordinate, false), publicCoordinate(coordinate));
  assert.equal(PRESENCE_TTL_MINUTES, 15);
});

test("reports and hazards use closed enums and bounded notes", () => {
  assert.equal(UserReportSchema.safeParse({ reportedUserId: 2, reason: "harassment", details: "x" }).success, true);
  assert.equal(UserReportSchema.safeParse({ reportedUserId: 2, reason: "revenge" }).success, false);
  assert.equal(HazardSchema.safeParse({ type: "broken_glass", severity: "severe", latitude: 40, longitude: -105, notes: "glass" }).success, true);
  assert.equal(HazardSchema.safeParse({ type: "crime", severity: "critical", latitude: 40, longitude: -105 }).success, false);
});

test("route ids accept only positive safe integers", () => {
  assert.equal(parseId("42"), 42);
  assert.equal(parseId("0"), null);
  assert.equal(parseId("1.5"), null);
  assert.equal(parseId("not-a-number"), null);
});

test("schema 59 contains the complete PawPath privacy and safety foundation", () => {
  const migration = MIGRATIONS.find((entry) => entry.version === 59);
  assert.equal(CURRENT_SCHEMA_VERSION, 59);
  assert.ok(migration);
  const sql = migration.statements.join("\n");
  for (const table of ["pawpath_location_settings", "pawpath_presence", "pawpath_friendships", "pawpath_blocks", "pawpath_user_reports", "pawpath_hazards", "pawpath_hazard_confirmations"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
});

test("every PawPath route is denied before database access without a bearer token", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/pawpath", createPawPathRouter({
    requireAuth,
    pool: () => { throw new Error("database must not be reached"); },
    isAdmin: async () => false,
  }));
  const probes = [
    ["get", "/bootstrap"], ["put", "/location-settings"], ["put", "/presence"],
    ["delete", "/presence"], ["get", "/map/users"], ["get", "/friends"],
    ["post", "/friends/2"], ["patch", "/friends/1"], ["post", "/blocks/2"],
    ["delete", "/blocks/2"], ["post", "/reports"], ["get", "/hazards"],
    ["post", "/hazards"], ["post", "/hazards/1/confirm"],
    ["get", "/moderation/reports"], ["patch", "/moderation/reports/1"],
  ];
  for (const [method, path] of probes) {
    const response = await request(app)[method](`/api/pawpath${path}`);
    assert.equal(response.status, 401, `${method.toUpperCase()} ${path}`);
  }
});
