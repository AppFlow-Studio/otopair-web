/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as bookings from "../bookings.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as invitations from "../invitations.js";
import type * as mcp_api from "../mcp_api.js";
import type * as mechanics from "../mechanics.js";
import type * as schedule from "../schedule.js";
import type * as seed from "../seed.js";
import type * as shops from "../shops.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  bookings: typeof bookings;
  crons: typeof crons;
  http: typeof http;
  invitations: typeof invitations;
  mcp_api: typeof mcp_api;
  mechanics: typeof mechanics;
  schedule: typeof schedule;
  seed: typeof seed;
  shops: typeof shops;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
