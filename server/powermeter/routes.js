/**
 * Power-meter routes. Registered behind the dashboard's auth middleware like every
 * other API route. While the feature is off only the status route answers.
 *
 *   GET  /api/power-meters                    configuration state, meters and current readings
 *   GET  /api/power-meters/energy             FleetEnergy-shaped live summary (metered)
 *   GET  /api/power-meters/energy/history     EnergyHistory-shaped hourly rows (metered)
 *   GET  /api/power-meters/energy/monthly     MonthlyEnergy-shaped roll-up (metered)
 *   POST /api/power-meters/reconcile          fetch the meters' history now
 */
const NOT_CONFIGURED = {
  error: "Power meters are not configured. Create config/power-meters.json (see docs/POWER-METERS.md).",
};

export function registerPowerMeterRoutes(app, { status, runtime = null }) {
  app.get("/api/power-meters", (_req, res) => res.json(status()));

  const guard = (handler) => (req, res) => {
    if (!runtime) return res.status(404).json(NOT_CONFIGURED);
    return handler(req, res);
  };

  app.get("/api/power-meters/energy", guard((_req, res) => res.json(runtime.live())));
  app.get("/api/power-meters/energy/history", guard((_req, res) => res.json(runtime.history())));
  app.get("/api/power-meters/energy/monthly", guard((_req, res) => res.json(runtime.monthly())));
  app.post(
    "/api/power-meters/reconcile",
    guard(async (_req, res) => {
      await runtime.reconcileOnce();
      res.json(status());
    })
  );
}
