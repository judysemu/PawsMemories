import express, { type ErrorRequestHandler, type Express } from "express";
import { bumpDailyUsage, dbConfigured, getPool } from "../../db";
import { EdgeHermesClient } from "./client";
import { GeminiHermesAdapter } from "./gemini_adapter";
import { loadHermesConfig } from "./config";
import { createHermesRouter, type HermesRouterDeps } from "./router";
import { MySqlHermesStore, type HermesStore } from "./store";

const HERMES_JSON_LIMIT = "256kb";

function unavailableStore(): HermesStore {
  const unavailable = async (): Promise<never> => {
    throw new Error("Hermes storage is unavailable.");
  };
  return {
    createJob: unavailable,
    setBridgeJob: unavailable,
    getJob: unavailable,
    updateJob: unavailable,
  };
}

const hermesJsonErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (error?.type === "entity.too.large" || error?.status === 413) {
    res.status(413).json({ error: "Hermes request exceeds the size limit." });
    return;
  }
  if (error instanceof SyntaxError || error?.status === 400) {
    res.status(400).json({ error: "Invalid JSON request." });
    return;
  }
  next(error);
};

/** The exact app mounted by production and exercised by contract tests. */
export function createHermesApp(deps: HermesRouterDeps): Express {
  const app = express();
  app.set("trust proxy", 1);
  app.use("/api/hermes", express.json({ limit: HERMES_JSON_LIMIT, strict: true }));
  app.use("/api/hermes", hermesJsonErrorHandler);
  app.use(createHermesRouter(deps));
  app.use("/api/hermes", (_req, res) => res.status(404).json({ error: "Hermes endpoint not found." }));
  return app;
}

export async function createProductionHermesApp(): Promise<Express> {
  const config = loadHermesConfig();
  const databaseReady = dbConfigured();
  if (config.enabled && !databaseReady) {
    throw new Error("Hermes requires database configuration.");
  }

  const mysqlStore = databaseReady ? new MySqlHermesStore(getPool()) : null;
  const store: HermesStore = mysqlStore || unavailableStore();
  if (mysqlStore) {
    try {
      await mysqlStore.ensureSchema();
    } catch {
      if (config.enabled) throw new Error("Hermes database initialization failed.");
      console.warn("[Hermes] Table initialization skipped while Hermes is disabled.");
    }
  }

  // Gemini adapter — active whenever the Hermes bridge is disabled (the default).
  // Uses the same GEMINI_API_KEY as the rest of the app so no new credentials
  // are needed. GEMINI_HERMES_MODEL defaults to "gemini-3.1-flash-lite".
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const geminiHermesModel = process.env.GEMINI_HERMES_MODEL || "gemini-3.1-flash-lite";
  const geminiAdapter = geminiApiKey
    ? new GeminiHermesAdapter(geminiApiKey, geminiHermesModel)
    : undefined;

  if (!config.enabled && !geminiAdapter) {
    console.warn("[Hermes] Bridge disabled and GEMINI_API_KEY is not set — all Hermes endpoints will return 503.");
  }

  return createHermesApp({
    enabled: config.enabled,
    client: config.enabled ? new EdgeHermesClient(config) : null,
    store,
    dailyUsage: {
      increment: (owner, type) => bumpDailyUsage(owner, `hermes_${type}`),
    },
    geminiAdapter,
  });
}
