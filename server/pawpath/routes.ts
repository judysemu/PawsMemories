import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import rateLimit from "express-rate-limit";
import type mysql from "mysql2/promise";
import type { AuthedRequest } from "../../auth";
import { FriendshipDecisionSchema, HazardSchema, LocationSettingsSchema, ModerationDecisionSchema, PresenceSchema, UserReportSchema, parseId } from "./schemas";
import { mapCoordinate, PRESENCE_TTL_MINUTES } from "./privacy";

type Pool = mysql.Pool;
type PawPathDeps = {
  pool: () => Pool;
  requireAuth: RequestHandler;
  isAdmin: (phone: string) => Promise<boolean>;
};

function invalid(res: any, parsed: any) {
  return res.status(400).json({ error: "Invalid request.", details: parsed.error.flatten() });
}

const asyncHandler = (handler: (req: any, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => { void handler(req, res, next).catch(next); };

export function createPawPathRouter(deps: PawPathDeps): Router {
  const router = Router();
  router.use(deps.requireAuth);
  router.use(rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));

  router.get("/bootstrap", asyncHandler(async (req: AuthedRequest, res) => {
    const phone = req.user!.phone;
    const [[userRows], [petRows], [settingRows]]: any = await Promise.all([
      deps.pool().query("SELECT id, full_name, city, profile_photo_url, email_verified FROM users WHERE phone = ? LIMIT 1", [phone]),
      deps.pool().query("SELECT id, name, kind FROM pets WHERE user_phone = ? ORDER BY id", [phone]),
      deps.pool().query("SELECT visibility, share_precise_with_friends FROM pawpath_location_settings WHERE user_phone = ? LIMIT 1", [phone]),
    ]);
    if (!userRows[0]) return res.status(404).json({ error: "User not found." });
    return res.json({
      user: userRows[0], pets: petRows,
      locationSettings: settingRows[0] || { visibility: "private", share_precise_with_friends: 0 },
    });
  }));

  router.put("/location-settings", asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = LocationSettingsSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed);
    await deps.pool().query(
      `INSERT INTO pawpath_location_settings (user_phone, visibility, share_precise_with_friends)
       VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE visibility=VALUES(visibility),
       share_precise_with_friends=VALUES(share_precise_with_friends), updated_at=NOW()`,
      [req.user!.phone, parsed.data.visibility, parsed.data.sharePreciseWithFriends ? 1 : 0],
    );
    if (parsed.data.visibility === "private") {
      await deps.pool().query("DELETE FROM pawpath_presence WHERE user_phone = ?", [req.user!.phone]);
    }
    return res.json({ success: true, ...parsed.data });
  }));

  router.put("/presence", asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = PresenceSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed);
    const phone = req.user!.phone;
    const [[settings], [pets]]: any = await Promise.all([
      deps.pool().query("SELECT visibility FROM pawpath_location_settings WHERE user_phone = ? LIMIT 1", [phone]),
      parsed.data.petId
        ? deps.pool().query("SELECT id FROM pets WHERE id = ? AND user_phone = ? LIMIT 1", [parsed.data.petId, phone])
        : Promise.resolve([[]]),
    ]);
    if (!settings[0] || settings[0].visibility === "private") {
      return res.status(403).json({ error: "Enable location sharing before publishing presence." });
    }
    if (parsed.data.petId && !pets[0]) return res.status(403).json({ error: "Pet does not belong to this account." });
    await deps.pool().query(
      `INSERT INTO pawpath_presence (user_phone, pet_id, latitude, longitude, accuracy_meters, expires_at)
       VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))
       ON DUPLICATE KEY UPDATE pet_id=VALUES(pet_id), latitude=VALUES(latitude), longitude=VALUES(longitude),
       accuracy_meters=VALUES(accuracy_meters), expires_at=VALUES(expires_at), updated_at=NOW()`,
      [phone, parsed.data.petId || null, parsed.data.latitude, parsed.data.longitude, parsed.data.accuracyMeters || null, PRESENCE_TTL_MINUTES],
    );
    return res.json({ success: true, expiresInSeconds: PRESENCE_TTL_MINUTES * 60 });
  }));

  router.delete("/presence", asyncHandler(async (req: AuthedRequest, res) => {
    await deps.pool().query("DELETE FROM pawpath_presence WHERE user_phone = ?", [req.user!.phone]);
    return res.json({ success: true });
  }));

  router.get("/map/users", asyncHandler(async (req: AuthedRequest, res) => {
    const latitude = Number(req.query.lat), longitude = Number(req.query.lng);
    const radius = Math.min(5000, Math.max(100, Number(req.query.radiusMeters) || 5000));
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return res.status(400).json({ error: "Valid lat and lng are required." });
    }
    const [rows]: any = await deps.pool().query(
      `SELECT u.id, u.full_name AS display_name, p.name AS pet_name, pr.latitude, pr.longitude,
              UNIX_TIMESTAMP(pr.updated_at) * 1000 AS updated_at_millis,
              s.visibility, s.share_precise_with_friends,
              EXISTS(SELECT 1 FROM pawpath_friendships f WHERE f.status='accepted' AND
                ((f.requester_phone=? AND f.addressee_phone=pr.user_phone) OR (f.addressee_phone=? AND f.requester_phone=pr.user_phone))) AS is_friend
       FROM pawpath_presence pr
       JOIN pawpath_location_settings s ON s.user_phone=pr.user_phone
       JOIN users u ON u.phone=pr.user_phone
       LEFT JOIN pets p ON p.id=pr.pet_id
       WHERE pr.user_phone<>? AND pr.expires_at>NOW() AND s.visibility<>'private'
         AND NOT EXISTS (SELECT 1 FROM pawpath_blocks b WHERE
           (b.blocker_phone=? AND b.blocked_phone=pr.user_phone) OR (b.blocker_phone=pr.user_phone AND b.blocked_phone=?))
       HAVING (visibility='community' OR is_friend=1)
         AND ST_Distance_Sphere(POINT(longitude, latitude), POINT(?, ?)) <= ?
       ORDER BY updated_at_millis DESC LIMIT 200`,
      [req.user!.phone, req.user!.phone, req.user!.phone, req.user!.phone, req.user!.phone, longitude, latitude, radius],
    );
    return res.json(rows.map((row: any) => {
      const precise = Boolean(row.is_friend && row.share_precise_with_friends);
      return { id: String(row.id), displayName: row.display_name || "PawPath user", petName: row.pet_name || "Pet",
        latitude: mapCoordinate(Number(row.latitude), precise), longitude: mapCoordinate(Number(row.longitude), precise),
        updatedAtMillis: Number(row.updated_at_millis) };
    }));
  }));

  router.get("/friends", asyncHandler(async (req: AuthedRequest, res) => {
    const [rows]: any = await deps.pool().query(
      `SELECT f.id, f.status, f.created_at,
        CASE WHEN f.requester_phone=? THEN addressee.id ELSE requester.id END AS user_id,
        CASE WHEN f.requester_phone=? THEN addressee.full_name ELSE requester.full_name END AS display_name,
        f.addressee_phone=? AS incoming
       FROM pawpath_friendships f
       JOIN users requester ON requester.phone=f.requester_phone
       JOIN users addressee ON addressee.phone=f.addressee_phone
       WHERE f.requester_phone=? OR f.addressee_phone=? ORDER BY f.updated_at DESC`,
      [req.user!.phone, req.user!.phone, req.user!.phone, req.user!.phone, req.user!.phone],
    );
    return res.json({ friends: rows });
  }));

  router.post("/friends/:userId", asyncHandler(async (req: AuthedRequest, res) => {
    const userId = parseId(req.params.userId);
    if (!userId || userId === req.user!.uid) return res.status(400).json({ error: "Invalid user." });
    const [rows]: any = await deps.pool().query("SELECT phone FROM users WHERE id=? LIMIT 1", [userId]);
    if (!rows[0]) return res.status(404).json({ error: "User not found." });
    const target = rows[0].phone;
    const [blocks]: any = await deps.pool().query(
      "SELECT 1 FROM pawpath_blocks WHERE (blocker_phone=? AND blocked_phone=?) OR (blocker_phone=? AND blocked_phone=?) LIMIT 1",
      [req.user!.phone, target, target, req.user!.phone],
    );
    if (blocks[0]) return res.status(403).json({ error: "Friend request is unavailable." });
    const [existing]: any = await deps.pool().query(
      "SELECT id FROM pawpath_friendships WHERE (requester_phone=? AND addressee_phone=?) OR (requester_phone=? AND addressee_phone=?) LIMIT 1",
      [req.user!.phone, target, target, req.user!.phone],
    );
    if (existing[0]) return res.status(409).json({ error: "A friendship request already exists." });
    await deps.pool().query(
      "INSERT INTO pawpath_friendships (requester_phone, addressee_phone) VALUES (?, ?)",
      [req.user!.phone, target],
    );
    return res.status(201).json({ success: true });
  }));

  router.patch("/friends/:id", asyncHandler(async (req: AuthedRequest, res) => {
    const id = parseId(req.params.id);
    const parsed = FriendshipDecisionSchema.safeParse(req.body);
    if (!id || !parsed.success) return res.status(400).json({ error: "Invalid friendship decision." });
    const [result]: any = await deps.pool().query(
      "UPDATE pawpath_friendships SET status=? WHERE id=? AND addressee_phone=? AND status='pending'",
      [parsed.data.status, id, req.user!.phone],
    );
    if (result.affectedRows !== 1) return res.status(404).json({ error: "Pending request not found." });
    return res.json({ success: true });
  }));

  router.post("/blocks/:userId", asyncHandler(async (req: AuthedRequest, res) => {
    const userId = parseId(req.params.userId);
    if (!userId || userId === req.user!.uid) return res.status(400).json({ error: "Invalid user." });
    const [rows]: any = await deps.pool().query("SELECT phone FROM users WHERE id=? LIMIT 1", [userId]);
    if (!rows[0]) return res.status(404).json({ error: "User not found." });
    await deps.pool().query("INSERT IGNORE INTO pawpath_blocks (blocker_phone, blocked_phone) VALUES (?, ?)", [req.user!.phone, rows[0].phone]);
    await deps.pool().query(
      "DELETE FROM pawpath_friendships WHERE (requester_phone=? AND addressee_phone=?) OR (requester_phone=? AND addressee_phone=?)",
      [req.user!.phone, rows[0].phone, rows[0].phone, req.user!.phone],
    );
    return res.status(201).json({ success: true });
  }));

  router.delete("/blocks/:userId", asyncHandler(async (req: AuthedRequest, res) => {
    const userId = parseId(req.params.userId);
    if (!userId) return res.status(400).json({ error: "Invalid user." });
    await deps.pool().query("DELETE b FROM pawpath_blocks b JOIN users u ON u.phone=b.blocked_phone WHERE b.blocker_phone=? AND u.id=?", [req.user!.phone, userId]);
    return res.json({ success: true });
  }));

  router.post("/reports", asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = UserReportSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed);
    if (parsed.data.reportedUserId === req.user!.uid) return res.status(400).json({ error: "You cannot report your own account." });
    const [rows]: any = await deps.pool().query("SELECT phone FROM users WHERE id=? LIMIT 1", [parsed.data.reportedUserId]);
    if (!rows[0]) return res.status(404).json({ error: "User not found." });
    await deps.pool().query(
      "INSERT INTO pawpath_user_reports (reporter_phone, reported_phone, reason, details) VALUES (?, ?, ?, ?)",
      [req.user!.phone, rows[0].phone, parsed.data.reason, parsed.data.details],
    );
    return res.status(201).json({ success: true });
  }));

  router.get("/hazards", asyncHandler(async (req: AuthedRequest, res) => {
    const latitude = Number(req.query.lat), longitude = Number(req.query.lng);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return res.status(400).json({ error: "Valid lat and lng are required." });
    const [rows]: any = await deps.pool().query(
      `SELECT id, type, severity, latitude, longitude, notes, confirmations, created_at, expires_at
       FROM pawpath_hazards WHERE status='active' AND expires_at>NOW()
       AND ST_Distance_Sphere(POINT(longitude, latitude), POINT(?, ?)) <= 10000
       ORDER BY severity DESC, created_at DESC LIMIT 200`, [longitude, latitude],
    );
    return res.json({ hazards: rows });
  }));

  router.post("/hazards", asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = HazardSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed);
    const ttlHours = parsed.data.severity === "critical" ? 6 : 24;
    const [result]: any = await deps.pool().query(
      `INSERT INTO pawpath_hazards (reporter_phone, type, severity, latitude, longitude, notes, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))`,
      [req.user!.phone, parsed.data.type, parsed.data.severity, parsed.data.latitude, parsed.data.longitude, parsed.data.notes, ttlHours],
    );
    return res.status(201).json({ success: true, id: result.insertId, expiresInSeconds: ttlHours * 3600 });
  }));

  router.post("/hazards/:id/confirm", asyncHandler(async (req: AuthedRequest, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid hazard." });
    await deps.pool().query("INSERT IGNORE INTO pawpath_hazard_confirmations (hazard_id, user_phone) VALUES (?, ?)", [id, req.user!.phone]);
    await deps.pool().query("UPDATE pawpath_hazards SET confirmations=(SELECT COUNT(*) FROM pawpath_hazard_confirmations WHERE hazard_id=?) WHERE id=?", [id, id]);
    return res.json({ success: true });
  }));

  router.get("/moderation/reports", asyncHandler(async (req: AuthedRequest, res) => {
    if (!(await deps.isAdmin(req.user!.phone))) return res.status(403).json({ error: "Operator access required." });
    const [rows]: any = await deps.pool().query(
      "SELECT id, reason, details, status, created_at, reviewed_at FROM pawpath_user_reports ORDER BY created_at DESC LIMIT 200",
    );
    return res.json({ reports: rows });
  }));

  router.patch("/moderation/reports/:id", asyncHandler(async (req: AuthedRequest, res) => {
    if (!(await deps.isAdmin(req.user!.phone))) return res.status(403).json({ error: "Operator access required." });
    const id = parseId(req.params.id);
    const parsed = ModerationDecisionSchema.safeParse(req.body);
    if (!id || !parsed.success) return res.status(400).json({ error: "Invalid moderation decision." });
    const [result]: any = await deps.pool().query(
      "UPDATE pawpath_user_reports SET status=?, reviewed_by_phone=?, reviewed_at=NOW() WHERE id=?",
      [parsed.data.status, req.user!.phone, id],
    );
    if (result.affectedRows !== 1) return res.status(404).json({ error: "Report not found." });
    return res.json({ success: true });
  }));

  return router;
}
