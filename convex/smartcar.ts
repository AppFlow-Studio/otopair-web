/**
 * Smartcar Integration — Convex Functions
 *
 * Actions:  External API calls to Smartcar
 * Mutations: Database writes (tokens, connections, mileage)
 * Queries:  Reactive reads for UI
 *
 * Fits into Otopair's 5-stage vehicle pipeline as:
 * - An alternative Stage 1 input (Smartcar Connect instead of manual VIN)
 * - An ongoing data source (webhooks update mileage, health data)
 */

import { v } from "convex/values";
import { action, query, internalMutation, internalQuery, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

// ============================================
// Config
// ============================================

const SMARTCAR_AUTH_URL = "https://auth.smartcar.com/oauth/token";
const SMARTCAR_API = "https://api.smartcar.com/v2.0";
const SMARTCAR_API_V3 = "https://vehicle.api.smartcar.com/v3";
const REDIRECT_URI = "otopair://smartcar/callback";

function getCredentials() {
  const clientId = process.env.SMARTCAR_CLIENT_ID;
  const clientSecret = process.env.SMARTCAR_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("SMARTCAR_CLIENT_ID and SMARTCAR_CLIENT_SECRET must be set");
  }
  return { clientId, clientSecret };
}

function basicAuth() {
  const { clientId, clientSecret } = getCredentials();
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

// ============================================
// CLIENT-FACING QUERIES
// ============================================

/**
 * Check if a vehicle_owner has an active Smartcar connection
 */
export const getConnectionStatus = query({
  args: { vehicleOwnerId: v.id("vehicle_owners") },
  handler: async (ctx, args) => {
    const connection = await ctx.db
      .query("smartcar_connections")
      .withIndex("by_vehicle_owner", (q) => q.eq("vehicleOwnerId", args.vehicleOwnerId))
      .first();

    if (!connection) return { connected: false };

    return {
      connected: connection.status === "active",
      connectedAt: connection.connectedAt,
      lastSyncedAt: connection.lastSyncedAt,
      status: connection.status,
    };
  },
});

/**
 * Get all connected vehicles for a user
 */
export const getUserConnectedVehicles = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    // Get user's vehicle_owners
    const vehicleOwners = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .collect();

    // Check which have active Smartcar connections
    const results = [];
    for (const vo of vehicleOwners) {
      const connection = await ctx.db
        .query("smartcar_connections")
        .withIndex("by_vehicle_owner", (q) => q.eq("vehicleOwnerId", vo._id))
        .first();

      results.push({
        ...vo,
        isSmartcarConnected: connection?.status === "active",
        lastSyncedAt: connection?.lastSyncedAt,
      });
    }

    return results;
  },
});

/**
 * Get the latest health snapshot of each type for a vehicle.
 * Returns structured data for the VehicleStatsCard UI.
 */
export const getLatestSnapshots = query({
  args: { vehicleOwnerId: v.id("vehicle_owners") },
  handler: async (ctx, args) => {
    const snapshotTypes = ["odometer", "tire_pressure", "oil_life", "fuel", "location", "lock_status", "service_history", "online_status"] as const;

    const snapshots: Record<string, any> = {};
    for (const type of snapshotTypes) {
      const latest = await ctx.db
        .query("vehicle_health_snapshots")
        .withIndex("by_vehicle_and_type", (q) =>
          q.eq("vehicleOwnerId", args.vehicleOwnerId).eq("snapshotType", type)
        )
        .order("desc")
        .first();
      if (latest) {
        snapshots[type] = {
          data: latest.data,
          recordedAt: latest.recordedAt,
        };
      }
    }

    // Get connection status for lastSyncedAt
    const connection = await ctx.db
      .query("smartcar_connections")
      .withIndex("by_vehicle_owner", (q) => q.eq("vehicleOwnerId", args.vehicleOwnerId))
      .first();

    return {
      odometer: snapshots.odometer || null,
      tirePressure: snapshots.tire_pressure || null,
      oilLife: snapshots.oil_life || null,
      fuel: snapshots.fuel || null,
      location: snapshots.location || null,
      lockStatus: snapshots.lock_status || null,
      serviceHistory: snapshots.service_history || null,
      onlineStatus: snapshots.online_status || null,
      lastSyncedAt: connection?.lastSyncedAt || null,
      isConnected: connection?.status === "active",
    };
  },
});

// ============================================
// ACTIONS — External API Calls
// ============================================

/**
 * Exchange OAuth authorization code for tokens.
 * Then fetch connected vehicles, decode VINs, and kick off the pipeline.
 *
 * Accepts an optional `vin` parameter for deterministic matching when the user
 * has already decoded their VIN via the Add Vehicle flow. When provided, only
 * the Smartcar vehicle matching that VIN will be linked.
 *
 * This is the main entry point after the user completes Smartcar Connect.
 */
export const exchangeCodeAndConnect = action({
  args: {
    code: v.string(),
    userId: v.id("users"),
    vin: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    try {
      const knownVin = args.vin?.toUpperCase().trim() || null;

      // ── Step 1: Exchange code for tokens ──
      const tokens = await exchangeCode(args.code);

      // ── Step 2: Get list of vehicle IDs ──
      const vehicleIds = await fetchVehicleIds(tokens.access_token);

      if (vehicleIds.length === 0) {
        return { success: false, error: "No vehicles found" };
      }

      const connectedVehicles = [];

      for (const smartcarVehicleId of vehicleIds) {
        // ── Step 3: Get vehicle info + VIN + all data from Smartcar ──
        const [info, vinData, odometerData, tirePressureData, oilLifeData, fuelData, locationData, securityData, serviceHistoryData] = await Promise.allSettled([
          fetchFromSmartcar(tokens.access_token, smartcarVehicleId, ""),
          fetchFromSmartcar(tokens.access_token, smartcarVehicleId, "/vin"),
          fetchFromSmartcar(tokens.access_token, smartcarVehicleId, "/odometer"),
          fetchFromSmartcar(tokens.access_token, smartcarVehicleId, "/tires/pressure"),
          fetchFromSmartcar(tokens.access_token, smartcarVehicleId, "/engine/oil"),
          fetchFromSmartcar(tokens.access_token, smartcarVehicleId, "/fuel"),
          fetchFromSmartcar(tokens.access_token, smartcarVehicleId, "/location"),
          fetchSignalV3(tokens.access_token, smartcarVehicleId, "closure-islocked"),
          fetchFromSmartcar(tokens.access_token, smartcarVehicleId, "/service/history"),
        ]);

        const vehicleInfo = info.status === "fulfilled" ? info.value : null;
        const smartcarVin = vinData.status === "fulfilled" ? vinData.value?.vin?.toUpperCase().trim() : null;
        const odometer = odometerData.status === "fulfilled" ? odometerData.value?.distance : null;
        const tirePressure = tirePressureData.status === "fulfilled" ? tirePressureData.value : null;
        const oilLife = oilLifeData.status === "fulfilled" ? oilLifeData.value : null;
        const fuel = fuelData.status === "fulfilled" ? fuelData.value : null;
        const location = locationData.status === "fulfilled" ? locationData.value : null;
        const lockSignal = securityData.status === "fulfilled" ? securityData.value : null;
        const lockStatus = lockSignal != null ? { isLocked: !!lockSignal.value, doors: [], windows: [] } : null;
        const rawServiceHistory = serviceHistoryData.status === "fulfilled" ? serviceHistoryData.value : null;
        const serviceHistory = rawServiceHistory?.serviceRecords ?? (Array.isArray(rawServiceHistory) ? rawServiceHistory : null);


        if (!vehicleInfo || !smartcarVin) {
          console.error(`Failed to get info/VIN for ${smartcarVehicleId}`);
          continue;
        }

        // ── Step 3b: Deterministic VIN matching ──
        // If caller provided a VIN (from the Add Vehicle flow), only link the
        // Smartcar vehicle whose VIN matches. Skip others.
        if (knownVin && smartcarVin !== knownVin) {
          console.log(`Skipping Smartcar vehicle ${smartcarVehicleId} (VIN ${smartcarVin}) — does not match known VIN ${knownVin}`);
          continue;
        }

        const vin = smartcarVin;

        // ── Step 4: Run VIN through pipeline (Stage 1 + 2) ──
        // Process NHTSA decode → create makes/models/trims/engines
        const pipelineResult = await ctx.runAction(internal.vehicle_pipeline.processVin, { vin });

        // ── Step 5: Create vehicle_owner + vehicle records (idempotent) ──
        const vehicleOwnerId = await ctx.runMutation(internal.smartcar.createVehicleOwnerFromSmartcar, {
          userId: args.userId,
          vin,
          smartcarVehicleId,
          mileage: odometer || 0,
          nickname: `${vehicleInfo.year} ${vehicleInfo.make} ${vehicleInfo.model}`,
          engineId: pipelineResult?.engineId || null,
          vehicleData: pipelineResult
            ? {
                year: pipelineResult.year,
                trimId: pipelineResult.trimId,
                engineId: pipelineResult.engineId,
                make: pipelineResult.make,
                model: pipelineResult.model,
              }
            : {
                year: vehicleInfo.year,
                trimId: null,
                engineId: null,
                make: vehicleInfo.make,
                model: vehicleInfo.model,
              },
        });

        // ── Step 6: Store Smartcar connection (tokens) ──
        await ctx.runMutation(internal.smartcar.storeConnection, {
          vehicleOwnerId,
          smartcarVehicleId,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresIn: tokens.expires_in,
        });

        // ── Step 6b: Subscribe vehicle to webhook (if configured) ──
        const webhookId = process.env.SMARTCAR_WEBHOOK_ID;
        if (webhookId) {
          try {
            const subResponse = await fetch(
              `https://api.smartcar.com/v2.0/vehicles/${smartcarVehicleId}/webhooks/${webhookId}`,
              {
                method: "POST",
                headers: { Authorization: `Bearer ${tokens.access_token}` },
              }
            );
            if (subResponse.ok) {
              console.log(`[Smartcar] Subscribed vehicle ${smartcarVehicleId} to webhook ${webhookId}`);
            } else {
              const errText = await subResponse.text();
              console.error(`[Smartcar] Failed to subscribe vehicle to webhook: ${subResponse.status} ${errText}`);
            }
          } catch (e) {
            console.error("[Smartcar] Webhook subscription error:", e);
          }
        }

        // ── Step 7: Store initial health snapshots ──
        if (odometer) {
          await ctx.runMutation(internal.smartcar.storeHealthSnapshot, {
            vehicleOwnerId,
            snapshotType: "odometer",
            data: { distance: odometer, unit: "mi" },
            source: "smartcar",
          });
        }
        if (tirePressure) {
          await ctx.runMutation(internal.smartcar.storeHealthSnapshot, {
            vehicleOwnerId,
            snapshotType: "tire_pressure",
            data: tirePressure,
            source: "smartcar",
          });
        }
        if (oilLife) {
          await ctx.runMutation(internal.smartcar.storeHealthSnapshot, {
            vehicleOwnerId,
            snapshotType: "oil_life",
            data: oilLife,
            source: "smartcar",
          });
        }
        if (fuel) {
          await ctx.runMutation(internal.smartcar.storeHealthSnapshot, {
            vehicleOwnerId,
            snapshotType: "fuel",
            data: fuel,
            source: "smartcar",
          });
        }
        if (location) {
          await ctx.runMutation(internal.smartcar.storeHealthSnapshot, {
            vehicleOwnerId,
            snapshotType: "location",
            data: location,
            source: "smartcar",
          });
        }
        if (lockStatus) {
          await ctx.runMutation(internal.smartcar.storeHealthSnapshot, {
            vehicleOwnerId,
            snapshotType: "lock_status",
            data: lockStatus,
            source: "smartcar",
          });
        }
        if (serviceHistory) {
          await ctx.runMutation(internal.smartcar.storeHealthSnapshot, {
            vehicleOwnerId,
            snapshotType: "service_history",
            data: serviceHistory,
            source: "smartcar",
          });
        }

        // ── Step 8: Trigger AI enrichment if engine_id exists ──
        if (pipelineResult?.engineId) {
          // Schedule AI enrichment (non-blocking)
          await ctx.scheduler.runAfter(0, internal.vehicle_pipeline.enrichVehicleSpecs, {
            engineId: pipelineResult.engineId,
            make: pipelineResult.make,
            model: pipelineResult.model,
            year: pipelineResult.year,
            trim: pipelineResult.trim,
            engineCode: pipelineResult.engineCode,
            displacement: pipelineResult.displacement,
            cylinders: pipelineResult.cylinders,
            fuelType: pipelineResult.fuelType,
          });
        }

        connectedVehicles.push({
          vin,
          make: vehicleInfo.make,
          model: vehicleInfo.model,
          year: vehicleInfo.year,
          odometer,
        });
      }

      if (knownVin && connectedVehicles.length === 0) {
        return {
          success: false,
          error: "Could not match your vehicle with Smartcar. Please try again.",
        };
      }

      return {
        success: true,
        vehicleCount: connectedVehicles.length,
        vehicles: connectedVehicles,
      };
    } catch (error) {
      console.error("Smartcar exchange error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Connection failed",
      };
    }
  },
});

/**
 * Fetch latest vehicle data from Smartcar on demand.
 * Handles token refresh automatically.
 */
export const fetchVehicleData = action({
  args: { vehicleOwnerId: v.id("vehicle_owners") },
  handler: async (ctx, args) => {
    console.log(`[fetchVehicleData] Starting for vehicleOwnerId=${args.vehicleOwnerId}`);

    // Get connection
    const connection = await ctx.runQuery(internal.smartcar.getConnectionByOwner, {
      vehicleOwnerId: args.vehicleOwnerId,
    });

    if (!connection || connection.status !== "active") {
      console.log(`[fetchVehicleData] No active connection found (status=${connection?.status ?? "null"})`);
      return { error: "Vehicle not connected" };
    }

    console.log(`[fetchVehicleData] Connection found, smartcarVehicleId=${connection.smartcarVehicleId}, tokenExpiresAt=${connection.tokenExpiresAt}, now=${Date.now()}, expired=${connection.tokenExpiresAt < Date.now()}`);

    // Refresh token if needed
    let accessToken = connection.accessToken;
    const now = Date.now();
    const fiveMin = 5 * 60 * 1000;

    if (connection.tokenExpiresAt < now + fiveMin) {
      console.log(`[fetchVehicleData] Token expired/expiring, refreshing...`);
      const newTokens = await refreshToken(connection.refreshToken);

      if (!newTokens) {
        console.log(`[fetchVehicleData] Token refresh FAILED, marking expired`);
        await ctx.runMutation(internal.smartcar.markConnectionExpired, {
          connectionId: connection._id,
        });
        return { error: "Connection expired. Please reconnect." };
      }

      accessToken = newTokens.access_token;

      await ctx.runMutation(internal.smartcar.updateTokens, {
        connectionId: connection._id,
        accessToken: newTokens.access_token,
        refreshToken: newTokens.refresh_token,
        expiresIn: newTokens.expires_in,
      });
    }

    // Fetch data via batch endpoint
    console.log(`[fetchVehicleData] Calling fetchBatchData...`);
    const data = await fetchBatchData(accessToken, connection.smartcarVehicleId);
    console.log(`[fetchVehicleData] fetchBatchData returned, keys=${Object.keys(data).join(",")}`);
    console.log(`[fetchVehicleData] odometer=${JSON.stringify(data.odometer)}, fuel=${JSON.stringify(data.fuel)}, oilLife=${JSON.stringify(data.oilLife)}`);

    // Store all health snapshots
    if (data.odometer) {
      await ctx.runMutation(internal.smartcar.updateMileage, {
        vehicleOwnerId: args.vehicleOwnerId,
        mileage: data.odometer.distance,
      });
      await ctx.runMutation(internal.smartcar.storeHealthSnapshot, {
        vehicleOwnerId: args.vehicleOwnerId,
        snapshotType: "odometer",
        data: data.odometer,
        source: "smartcar",
      });
      // Log to odometer_history for trip stats
      await ctx.runMutation(internal.smartcar.logOdometerReading, {
        vehicleOwnerId: args.vehicleOwnerId,
        distance: data.odometer.distance,
        unit: data.odometer.unit || "mi",
      });
    }
    if (data.tirePressure) {
      await ctx.runMutation(internal.smartcar.storeHealthSnapshot, {
        vehicleOwnerId: args.vehicleOwnerId,
        snapshotType: "tire_pressure",
        data: data.tirePressure,
        source: "smartcar",
      });
    }
    if (data.oilLife) {
      await ctx.runMutation(internal.smartcar.storeHealthSnapshot, {
        vehicleOwnerId: args.vehicleOwnerId,
        snapshotType: "oil_life",
        data: data.oilLife,
        source: "smartcar",
      });
    }
    if (data.fuel) {
      await ctx.runMutation(internal.smartcar.storeHealthSnapshot, {
        vehicleOwnerId: args.vehicleOwnerId,
        snapshotType: "fuel",
        data: data.fuel,
        source: "smartcar",
      });
    }
    if (data.location) {
      await ctx.runMutation(internal.smartcar.storeHealthSnapshot, {
        vehicleOwnerId: args.vehicleOwnerId,
        snapshotType: "location",
        data: data.location,
        source: "smartcar",
      });
    }
    if (data.lockStatus) {
      await ctx.runMutation(internal.smartcar.storeHealthSnapshot, {
        vehicleOwnerId: args.vehicleOwnerId,
        snapshotType: "lock_status",
        data: data.lockStatus,
        source: "smartcar",
      });
    }
    if (data.serviceHistory) {
      await ctx.runMutation(internal.smartcar.storeHealthSnapshot, {
        vehicleOwnerId: args.vehicleOwnerId,
        snapshotType: "service_history",
        data: data.serviceHistory,
        source: "smartcar",
      });
    }

    // Update lastSyncedAt
    await ctx.runMutation(internal.smartcar.markSynced, {
      connectionId: connection._id,
    });

    return data;
  },
});

/**
 * Disconnect a vehicle from Smartcar
 */
export const disconnectVehicle = action({
  args: { vehicleOwnerId: v.id("vehicle_owners") },
  handler: async (ctx, args) => {
    const connection = await ctx.runQuery(internal.smartcar.getConnectionByOwner, {
      vehicleOwnerId: args.vehicleOwnerId,
    });

    if (!connection) {
      return { success: false, error: "No connection found" };
    }

    // Revoke at Smartcar
    if (connection.accessToken) {
      try {
        await fetch(`${SMARTCAR_API}/vehicles/${connection.smartcarVehicleId}/application`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${connection.accessToken}`,
          },
        });
      } catch (err) {
        console.error("Smartcar revoke failed:", err);
      }
    }

    // Remove from DB
    await ctx.runMutation(internal.smartcar.deleteConnection, {
      connectionId: connection._id,
    });

    return { success: true };
  },
});

/**
 * Check VIN compatibility with Smartcar
 */
export const checkCompatibility = action({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    if (args.vin.length !== 17) {
      return { compatible: false, reason: "Invalid VIN" };
    }

    try {
      const scopes = "read_vehicle_info read_odometer read_location read_tires read_engine_oil read_fuel";
      const response = await fetch(
        `${SMARTCAR_API}/compatibility?vin=${args.vin}&scope=${encodeURIComponent(scopes)}&country=US`,
        { headers: { Authorization: basicAuth() } },
      );

      if (!response.ok) {
        return { compatible: false, reason: "VIN not recognized" };
      }

      const data = await response.json();
      const capabilities: string[] = [];
      if (data.capabilities) {
        for (const cap of data.capabilities) {
          if (cap.capable) capabilities.push(cap.permission);
        }
      }

      return {
        compatible: data.compatible === true,
        capabilities: data.compatible ? capabilities : undefined,
        reason: data.compatible ? undefined : data.reason || "Not supported",
      };
    } catch (error) {
      return { compatible: false, reason: "Check failed" };
    }
  },
});

// ============================================
// INTERNAL ACTION — Webhook Data Fetch
// ============================================

/**
 * Process v3 webhook signal data directly from the payload.
 * No external API calls needed — signals are delivered inline.
 *
 * Signal codes we care about:
 *   - closure-islocked → lock_status snapshot
 *   - connectivitystatus-isonline → online_status snapshot
 *   - internalcombustionengine-fuellevel → fuel snapshot
 *   - odometer-traveleddistance → odometer snapshot + mileage update
 */
export const processWebhookSignals = internalAction({
  args: {
    smartcarVehicleId: v.string(),
    signals: v.array(
      v.object({
        code: v.string(),
        name: v.string(),
        group: v.string(),
        body: v.any(),
        hasError: v.boolean(),
      })
    ),
    eventId: v.string(),
  },
  handler: async (ctx, args) => {
    // Find the connection/ownership for this vehicle
    const connection = await ctx.runQuery(
      internal.smartcar.getConnectionBySmartcarId,
      { smartcarVehicleId: args.smartcarVehicleId }
    );

    let vehicleOwnerId = connection?.vehicleOwnerId;

    if (!vehicleOwnerId) {
      // Fallback: try vehicle_owners table
      const owner = await ctx.runQuery(
        internal.smartcar.getOwnerBySmartcarVehicleId,
        { smartcarVehicleId: args.smartcarVehicleId }
      );
      if (!owner) {
        console.error(`[Webhook Signals] No connection or owner found for ${args.smartcarVehicleId}`);
        return;
      }
      vehicleOwnerId = owner._id;
    }

    let storedCount = 0;

    for (const signal of args.signals) {
      if (signal.hasError || !signal.body) continue;

      // Lock status: closure-islocked
      if (signal.code === "closure-islocked") {
        await ctx.runMutation(internal.smartcar.storeHealthSnapshot, {
          vehicleOwnerId,
          snapshotType: "lock_status",
          data: { isLocked: !!signal.body.value, doors: [], windows: [] },
          source: "webhook",
        });
        storedCount++;
      }

      // Online status: connectivitystatus-isonline
      if (signal.code === "connectivitystatus-isonline") {
        await ctx.runMutation(internal.smartcar.storeHealthSnapshot, {
          vehicleOwnerId,
          snapshotType: "online_status",
          data: { isOnline: !!signal.body.value },
          source: "webhook",
        });
        storedCount++;
      }

      // Fuel level: internalcombustionengine-fuellevel
      // DISABLED: Direct API provides better data (includes range/miles left).
      // Webhook only sends percentage without range. Re-enable when needed
      // for vehicles where webhooks add value (e.g. Tesla, BMW).
      // if (signal.code === "internalcombustionengine-fuellevel") {
      //   const pct = (signal.body.value ?? 0) / 100;
      //   await ctx.runMutation(internal.smartcar.storeHealthSnapshot, {
      //     vehicleOwnerId,
      //     snapshotType: "fuel",
      //     data: { percentRemaining: pct, range: null, amountRemaining: null },
      //     source: "webhook",
      //   });
      //   storedCount++;
      // }

      // Odometer: odometer-traveleddistance
      // DISABLED: Direct API provides better data (returns in imperial units).
      // Webhook delivers in km requiring conversion. Re-enable when needed.
      // if (signal.code === "odometer-traveleddistance") {
      //   const distanceKm = signal.body.value ?? 0;
      //   const unit = signal.body.unit || "kilometers";
      //   const distanceMi = unit === "kilometers" ? distanceKm * 0.621371 : distanceKm;
      //   await ctx.runMutation(internal.smartcar.storeHealthSnapshot, {
      //     vehicleOwnerId,
      //     snapshotType: "odometer",
      //     data: { distance: distanceMi, unit: "mi" },
      //     source: "webhook",
      //   });
      //   await ctx.runMutation(internal.smartcar.updateMileage, {
      //     vehicleOwnerId,
      //     mileage: distanceMi,
      //   });
      //   storedCount++;
      // }
    }

    // Update lastSyncedAt
    if (connection && storedCount > 0) {
      await ctx.runMutation(internal.smartcar.markSynced, {
        connectionId: connection._id,
      });
    }

    console.log(`[Webhook Signals] Stored ${storedCount} snapshots for ${args.smartcarVehicleId}`);
  },
});

/**
 * Called from the webhook handler to fetch fresh data and update DB.
 * This is an internalAction because it makes external API calls.
 *
 * Lookup strategy:
 *   1. Primary: smartcar_connections.by_smartcar_vehicle_id
 *   2. Fallback: vehicle_owners.by_smartcar_vehicle_id (new index)
 */
export const syncVehicleFromWebhook = internalAction({
  args: {
    smartcarVehicleId: v.string(),
    eventType: v.string(),
  },
  handler: async (ctx, args) => {
    console.log(`[Webhook Sync] Starting sync for smartcarVehicleId=${args.smartcarVehicleId}, event=${args.eventType}`);

    // ── Primary lookup: smartcar_connections ──
    let connection = await ctx.runQuery(internal.smartcar.getConnectionBySmartcarId, {
      smartcarVehicleId: args.smartcarVehicleId,
    });

    if (!connection || connection.status !== "active") {
      // ── Fallback: find vehicle_owner by smartcarVehicleId ──
      console.log(`[Webhook Sync] No active connection in smartcar_connections, checking vehicle_owners fallback`);
      const ownerRecord = await ctx.runQuery(internal.smartcar.getOwnerBySmartcarVehicleId, {
        smartcarVehicleId: args.smartcarVehicleId,
      });
      if (ownerRecord) {
        // Try connection lookup by vehicle_owner ID
        connection = await ctx.runQuery(internal.smartcar.getConnectionByOwner, {
          vehicleOwnerId: ownerRecord._id,
        });
      }

      if (!connection || connection.status !== "active") {
        console.log(`[Webhook Sync] No active connection found for ${args.smartcarVehicleId} — skipping`);
        return;
      }
    }

    console.log(`[Webhook Sync] Found connection=${connection._id}, vehicleOwnerId=${connection.vehicleOwnerId}`);

    // Refresh token if needed
    let accessToken = connection.accessToken;
    const now = Date.now();
    const fiveMin = 5 * 60 * 1000;

    if (connection.tokenExpiresAt < now + fiveMin) {
      console.log(`[Webhook Sync] Token expired/expiring — refreshing`);
      const newTokens = await refreshToken(connection.refreshToken);
      if (!newTokens) {
        console.error(`[Webhook Sync] Token refresh failed — marking connection expired`);
        await ctx.runMutation(internal.smartcar.markConnectionExpired, {
          connectionId: connection._id,
        });
        return;
      }
      accessToken = newTokens.access_token;
      await ctx.runMutation(internal.smartcar.updateTokens, {
        connectionId: connection._id,
        accessToken: newTokens.access_token,
        refreshToken: newTokens.refresh_token,
        expiresIn: newTokens.expires_in,
      });
    }

    // Fetch vehicle data
    const data = await fetchBatchData(accessToken, args.smartcarVehicleId);

    // Update mileage on vehicle_owners
    if (data.odometer) {
      await ctx.runMutation(internal.smartcar.updateMileage, {
        vehicleOwnerId: connection.vehicleOwnerId,
        mileage: data.odometer.distance,
      });
      await ctx.runMutation(internal.smartcar.storeHealthSnapshot, {
        vehicleOwnerId: connection.vehicleOwnerId,
        snapshotType: "odometer",
        data: data.odometer,
        source: "smartcar",
      });
      // Log to odometer_history for trip stats
      await ctx.runMutation(internal.smartcar.logOdometerReading, {
        vehicleOwnerId: connection.vehicleOwnerId,
        distance: data.odometer.distance,
        unit: data.odometer.unit || "mi",
      });
    }

    // Store tire pressure
    if (data.tirePressure) {
      await ctx.runMutation(internal.smartcar.storeHealthSnapshot, {
        vehicleOwnerId: connection.vehicleOwnerId,
        snapshotType: "tire_pressure",
        data: data.tirePressure,
        source: "smartcar",
      });
    }

    // Store oil life
    if (data.oilLife) {
      await ctx.runMutation(internal.smartcar.storeHealthSnapshot, {
        vehicleOwnerId: connection.vehicleOwnerId,
        snapshotType: "oil_life",
        data: data.oilLife,
        source: "smartcar",
      });
    }

    // Store fuel
    if (data.fuel) {
      await ctx.runMutation(internal.smartcar.storeHealthSnapshot, {
        vehicleOwnerId: connection.vehicleOwnerId,
        snapshotType: "fuel",
        data: data.fuel,
        source: "smartcar",
      });
    }

    // Store location
    if (data.location) {
      await ctx.runMutation(internal.smartcar.storeHealthSnapshot, {
        vehicleOwnerId: connection.vehicleOwnerId,
        snapshotType: "location",
        data: data.location,
        source: "smartcar",
      });
    }

    // Store lock status
    if (data.lockStatus) {
      await ctx.runMutation(internal.smartcar.storeHealthSnapshot, {
        vehicleOwnerId: connection.vehicleOwnerId,
        snapshotType: "lock_status",
        data: data.lockStatus,
        source: "smartcar",
      });
    }

    // Store service history
    if (data.serviceHistory) {
      await ctx.runMutation(internal.smartcar.storeHealthSnapshot, {
        vehicleOwnerId: connection.vehicleOwnerId,
        snapshotType: "service_history",
        data: data.serviceHistory,
        source: "smartcar",
      });
    }

    // Mark synced
    await ctx.runMutation(internal.smartcar.markSynced, {
      connectionId: connection._id,
    });

    console.log(`[Webhook Sync] Completed sync for smartcarVehicleId=${args.smartcarVehicleId}`);
  },
});

// ============================================
// INTERNAL QUERIES
// ============================================

export const getConnectionByOwner = internalQuery({
  args: { vehicleOwnerId: v.id("vehicle_owners") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("smartcar_connections")
      .withIndex("by_vehicle_owner", (q) => q.eq("vehicleOwnerId", args.vehicleOwnerId))
      .first();
  },
});

export const getConnectionBySmartcarId = internalQuery({
  args: { smartcarVehicleId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("smartcar_connections")
      .withIndex("by_smartcar_vehicle_id", (q) => q.eq("smartcarVehicleId", args.smartcarVehicleId))
      .first();
  },
});

export const getAllActiveConnections = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("smartcar_connections")
      .filter((q) => q.eq(q.field("status"), "active"))
      .collect();
  },
});

/**
 * Fallback lookup: find vehicle_owner by smartcarVehicleId (new index).
 * Used by webhook sync when smartcar_connections lookup fails.
 */
export const getOwnerBySmartcarVehicleId = internalQuery({
  args: { smartcarVehicleId: v.string() },
  handler: async (ctx, args) => {
    // Legacy Smartcar fallback: keep this type-only escape hatch instead of
    // reintroducing a vehicle_owners Smartcar index into the active schema.
    return await ctx.db
      .query("vehicle_owners")
      .withIndex("by_smartcar_vehicle_id" as any, (q: any) => q.eq("smartcarVehicleId", args.smartcarVehicleId))
      .first();
  },
});

// ============================================
// INTERNAL MUTATIONS
// ============================================

/**
 * Create vehicle_owner + vehicle records from Smartcar data.
 * Handles dedup — if a vehicle_owner with this VIN already exists
 * for this user, updates it with Smartcar fields. Idempotent.
 */
export const createVehicleOwnerFromSmartcar = internalMutation({
  args: {
    userId: v.id("users"),
    vin: v.string(),
    smartcarVehicleId: v.string(),
    mileage: v.float64(),
    nickname: v.string(),
    engineId: v.optional(v.union(v.id("engines"), v.null())),
    vehicleData: v.object({
      year: v.float64(),
      trimId: v.optional(v.union(v.id("trims"), v.null())),
      engineId: v.optional(v.union(v.id("engines"), v.null())),
      make: v.string(),
      model: v.string(),
    }),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Check if vehicle_owner already exists for this user + VIN
    const existingOwners = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .collect();

    const existing = existingOwners.find((vo) => vo.vin === args.vin);
    if (existing) {
      // Idempotent update: set Smartcar fields + bump mileage if fresher
      const updates: Record<string, unknown> = {
        smartcarVehicleId: args.smartcarVehicleId,
        connectionStatus: "connected",
        connectedAt: now,
      };
      if (args.mileage > 0 && args.mileage > (existing.mileage ?? 0)) {
        updates.mileage = args.mileage;
      }
      // Reactivate if it was removed
      if (existing.status === "removed") {
        updates.status = "active";
        updates.removed_at = undefined;
        updates.added_at = now;
      }
      await ctx.db.patch(existing._id, updates);
      return existing._id;
    }

    // Check if vehicle record exists; create if missing (so My Cars can display it)
    const existingVehicles = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", args.vin))
      .collect();

    if (existingVehicles.length === 0) {
      const vehicleRecord: Record<string, unknown> = {
        vin: args.vin,
        year: args.vehicleData.year,
        metadata: {
          make: args.vehicleData.make ?? "",
          model: args.vehicleData.model ?? "",
          body_style: "",
          color: "",
        },
        created_at: now,
        updated_at: now,
      };
      if (args.vehicleData.trimId) vehicleRecord.trim_id = args.vehicleData.trimId;
      if (args.vehicleData.engineId) vehicleRecord.engine_id = args.vehicleData.engineId;
      await ctx.db.insert("vehicles", vehicleRecord as any);
    }

    // Create vehicle_owner record with Smartcar fields
    const vehicleOwnerId = await ctx.db.insert("vehicle_owners", {
      user_id: args.userId,
      vin: args.vin,
      mileage: args.mileage,
      nickname: args.nickname,
      status: "active",
      is_primary: existingOwners.length === 0, // First vehicle = primary
      added_at: now,
      smartcarVehicleId: args.smartcarVehicleId,
      connectionStatus: "connected",
      connectedAt: now,
    });

    return vehicleOwnerId;
  },
});

/**
 * Store a Smartcar connection (tokens)
 */
export const storeConnection = internalMutation({
  args: {
    vehicleOwnerId: v.id("vehicle_owners"),
    smartcarVehicleId: v.string(),
    accessToken: v.string(),
    refreshToken: v.string(),
    expiresIn: v.float64(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const expiresAt = now + args.expiresIn * 1000;

    // Check for existing connection
    const existing = await ctx.db
      .query("smartcar_connections")
      .withIndex("by_vehicle_owner", (q) => q.eq("vehicleOwnerId", args.vehicleOwnerId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        smartcarVehicleId: args.smartcarVehicleId,
        accessToken: args.accessToken,
        refreshToken: args.refreshToken,
        tokenExpiresAt: expiresAt,
        connectedAt: now,
        status: "active",
      });
      return existing._id;
    }

    return await ctx.db.insert("smartcar_connections", {
      vehicleOwnerId: args.vehicleOwnerId,
      smartcarVehicleId: args.smartcarVehicleId,
      accessToken: args.accessToken,
      refreshToken: args.refreshToken,
      tokenExpiresAt: expiresAt,
      connectedAt: now,
      status: "active",
    });
  },
});

/**
 * Update tokens after refresh
 */
export const updateTokens = internalMutation({
  args: {
    connectionId: v.id("smartcar_connections"),
    accessToken: v.string(),
    refreshToken: v.string(),
    expiresIn: v.float64(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.connectionId, {
      accessToken: args.accessToken,
      refreshToken: args.refreshToken,
      tokenExpiresAt: Date.now() + args.expiresIn * 1000,
    });
  },
});

/**
 * Mark connection as expired
 */
export const markConnectionExpired = internalMutation({
  args: { connectionId: v.id("smartcar_connections") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.connectionId, { status: "expired" });
  },
});

/**
 * Mark connection as synced
 */
export const markSynced = internalMutation({
  args: { connectionId: v.id("smartcar_connections") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.connectionId, { lastSyncedAt: Date.now() });
  },
});

/**
 * Delete connection (disconnect)
 */
export const deleteConnection = internalMutation({
  args: { connectionId: v.id("smartcar_connections") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.connectionId);
  },
});

/**
 * Update mileage on vehicle_owners
 */
export const updateMileage = internalMutation({
  args: {
    vehicleOwnerId: v.id("vehicle_owners"),
    mileage: v.float64(),
  },
  handler: async (ctx, args) => {
    const vo = await ctx.db.get(args.vehicleOwnerId);
    if (!vo) return;

    const prevMileage = vo.mileage ?? 0;
    // Stamp the write time + source so resolveVehicleMileage can weigh this
    // reading by recency against the shop passport.
    await ctx.db.patch(args.vehicleOwnerId, {
      mileage: args.mileage,
      mileage_updated_at: Date.now(),
      mileage_source: "smartcar",
    });

    // Trigger maintenance pipeline recalculation when mileage changes significantly (500+ mi)
    if (vo.preOnboardingComplete && Math.abs(args.mileage - prevMileage) >= 500) {
      await ctx.scheduler.runAfter(
        0,
        internal.maintenance_pipeline.runPipeline,
        { vehicleOwnerId: args.vehicleOwnerId, triggeredBy: "mileage_update" }
      );
    }
  },
});

/**
 * Store a health snapshot
 */
export const storeHealthSnapshot = internalMutation({
  args: {
    vehicleOwnerId: v.id("vehicle_owners"),
    snapshotType: v.string(),
    data: v.any(),
    source: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("vehicle_health_snapshots", {
      vehicleOwnerId: args.vehicleOwnerId,
      snapshotType: args.snapshotType,
      data: args.data,
      source: args.source,
      recordedAt: now,
      createdAt: now,
    });
  },
});

/**
 * Log an odometer reading to odometer_history (deduplicated).
 * Only inserts if the distance changed from the last entry.
 */
export const logOdometerReading = internalMutation({
  args: {
    vehicleOwnerId: v.id("vehicle_owners"),
    distance: v.float64(),
    unit: v.string(),
  },
  handler: async (ctx, args) => {
    // Get the last entry
    const lastEntry = await ctx.db
      .query("odometer_history")
      .withIndex("by_vehicle_and_date", (q) =>
        q.eq("vehicleOwnerId", args.vehicleOwnerId)
      )
      .order("desc")
      .first();

    // Skip if same value (deduplicate)
    if (lastEntry && Math.abs(lastEntry.distance - args.distance) < 0.5) {
      return;
    }

    await ctx.db.insert("odometer_history", {
      vehicleOwnerId: args.vehicleOwnerId,
      distance: args.distance,
      unit: args.unit,
      recordedAt: Date.now(),
    });
  },
});

/**
 * Get odometer history for the last N days (default 30).
 * Returns array of { distance, recordedAt } sorted ascending by date.
 */
export const getOdometerHistory = query({
  args: {
    vehicleOwnerId: v.id("vehicle_owners"),
    daysBack: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    const days = args.daysBack ?? 30;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    const entries = await ctx.db
      .query("odometer_history")
      .withIndex("by_vehicle_and_date", (q) =>
        q.eq("vehicleOwnerId", args.vehicleOwnerId).gte("recordedAt", cutoff)
      )
      .order("asc")
      .collect();

    return entries.map((e) => ({
      distance: e.distance,
      unit: e.unit,
      recordedAt: e.recordedAt,
    }));
  },
});

// ============================================
// SMARTCAR HTTP HELPERS
// ============================================

async function exchangeCode(code: string) {
  const response = await fetch(SMARTCAR_AUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuth(),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error("Token exchange failed:", err);
    throw new Error("Failed to exchange authorization code");
  }

  return response.json();
}

async function refreshToken(token: string) {
  try {
    const response = await fetch(SMARTCAR_AUTH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: basicAuth(),
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token,
      }),
    });

    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

async function fetchVehicleIds(accessToken: string): Promise<string[]> {
  const response = await fetch(`${SMARTCAR_API}/vehicles`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error("Failed to get vehicles");
  const data = await response.json();
  return data.vehicles || [];
}

async function fetchFromSmartcar(accessToken: string, vehicleId: string, path: string) {
  try {
    const response = await fetch(`${SMARTCAR_API}/vehicles/${vehicleId}${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "SC-Unit-System": "imperial",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

/**
 * Fetch a single signal from the Smartcar Signals API (v3).
 * Returns the signal body or null on failure.
 */
async function fetchSignalV3(accessToken: string, vehicleId: string, signalCode: string) {
  try {
    const response = await fetch(
      `${SMARTCAR_API_V3}/vehicles/${vehicleId}/signals/${signalCode}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8_000),
      }
    );
    if (!response.ok) return null;
    const data = await response.json();
    return data?.data?.attributes?.body ?? data?.attributes?.body ?? null;
  } catch {
    return null;
  }
}

async function fetchBatchData(accessToken: string, smartcarVehicleId: string) {
  // Run all three requests in PARALLEL to avoid sequential timeouts
  const [batchResult, lockResult, serviceResult] = await Promise.allSettled([
    // 1. Batch request for core data (10s timeout in case OEM servers are slow)
    fetch(`${SMARTCAR_API}/vehicles/${smartcarVehicleId}/batch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "SC-Unit-System": "imperial",
      },
      body: JSON.stringify({
        requests: [
          { path: "/" },
          { path: "/odometer" },
          { path: "/location" },
          { path: "/tires/pressure" },
          { path: "/engine/oil" },
          { path: "/fuel" },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    }),
    // 2. Lock status via Signals API v3 (may not be supported)
    fetchSignalV3(accessToken, smartcarVehicleId, "closure-islocked"),
    // 3. Service history (may not be supported)
    fetchFromSmartcar(accessToken, smartcarVehicleId, "/service/history"),
  ]);

  // Process lock status
  const lockSignal = lockResult.status === "fulfilled" ? lockResult.value : null;
  const lockStatus = lockSignal != null ? { isLocked: !!lockSignal.value, doors: [], windows: [] } : null;

  // Process service history
  let serviceHistory = null;
  if (serviceResult.status === "fulfilled" && serviceResult.value) {
    const raw = serviceResult.value;
    if (raw?.serviceRecords) {
      serviceHistory = raw.serviceRecords;
    } else if (Array.isArray(raw)) {
      serviceHistory = raw;
    }
  }

  // Process batch response
  const response = batchResult.status === "fulfilled" ? batchResult.value : null;
  if (!response || !response.ok) {
    // Fallback to individual requests (also run in parallel via fetchIndividual)
    const individual = await fetchIndividual(accessToken, smartcarVehicleId);
    return { ...individual, lockStatus: individual.lockStatus ?? lockStatus, serviceHistory };
  }

  const batch = await response.json();

  return {
    info: extract(batch, "/"),
    odometer: formatOdometer(extract(batch, "/odometer")),
    location: extract(batch, "/location"),
    tirePressure: extract(batch, "/tires/pressure"),
    oilLife: extract(batch, "/engine/oil"),
    fuel: extract(batch, "/fuel"),
    lockStatus,
    serviceHistory,
  };
}

async function fetchIndividual(accessToken: string, vehicleId: string) {
  const get = (path: string) => fetchFromSmartcar(accessToken, vehicleId, path);

  const [info, odo, loc, tires, oil, fuel, lockSignalResult] = await Promise.allSettled([
    get(""),
    get("/odometer"),
    get("/location"),
    get("/tires/pressure"),
    get("/engine/oil"),
    get("/fuel"),
    fetchSignalV3(accessToken, vehicleId, "closure-islocked"),
  ]);

  const lockSignal = lockSignalResult.status === "fulfilled" ? lockSignalResult.value : null;

  return {
    info: info.status === "fulfilled" ? info.value : null,
    odometer: formatOdometer(odo.status === "fulfilled" ? odo.value : null),
    location: loc.status === "fulfilled" ? loc.value : null,
    tirePressure: tires.status === "fulfilled" ? tires.value : null,
    oilLife: oil.status === "fulfilled" ? oil.value : null,
    fuel: fuel.status === "fulfilled" ? fuel.value : null,
    lockStatus: lockSignal != null ? { isLocked: !!lockSignal.value, doors: [], windows: [] } : null,
    serviceHistory: null,
  };
}

/**
 * One-off action: Subscribe all active connected vehicles to the webhook.
 * Call via Convex dashboard or CLI: npx convex run smartcar:subscribeAllVehiclesToWebhook
 */
export const subscribeAllVehiclesToWebhook = action({
  args: {},
  handler: async (ctx) => {
    const webhookId = process.env.SMARTCAR_WEBHOOK_ID;
    if (!webhookId) {
      return { error: "SMARTCAR_WEBHOOK_ID not set" };
    }

    const connections: any[] = await ctx.runQuery(internal.smartcar.getAllActiveConnections, {});
    let subscribed = 0;
    let failed = 0;

    for (const conn of connections) {
      // Refresh token if needed
      let accessToken = conn.accessToken;
      const now = Date.now();
      if (conn.tokenExpiresAt && conn.tokenExpiresAt < now + 60_000) {
        try {
          const refreshed = await refreshToken(conn.refreshToken);
          accessToken = refreshed.access_token;
          await ctx.runMutation(internal.smartcar.updateTokens, {
            connectionId: conn._id,
            accessToken: refreshed.access_token,
            refreshToken: refreshed.refresh_token,
            expiresIn: refreshed.expires_in,
          });
        } catch (e) {
          console.error(`[Webhook Sub] Token refresh failed for ${conn.smartcarVehicleId}:`, e);
          failed++;
          continue;
        }
      }

      try {
        const res = await fetch(
          `https://api.smartcar.com/v2.0/vehicles/${conn.smartcarVehicleId}/webhooks/${webhookId}`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        );
        if (res.ok) {
          console.log(`[Webhook Sub] Subscribed ${conn.smartcarVehicleId}`);
          subscribed++;
        } else {
          const errText = await res.text();
          console.error(`[Webhook Sub] Failed ${conn.smartcarVehicleId}: ${res.status} ${errText}`);
          failed++;
        }
      } catch (e) {
        console.error(`[Webhook Sub] Error subscribing ${conn.smartcarVehicleId}:`, e);
        failed++;
      }
    }

    return { subscribed, failed, total: connections.length };
  },
});

function extract(batch: any, path: string) {
  const r = batch.responses?.find((r: any) => r.path === path);
  if (!r || r.code !== 200) return null;
  return r.body;
}

function formatOdometer(data: any) {
  if (!data) return null;
  return {
    distance: data.distance,
    unit: data.meta?.unitSystem === "metric" ? "km" : "mi",
    dataAge: data.meta?.dataAge,
  };
}
