/**
 * Smartcar Client-Side OAuth
 * Opens Smartcar Connect, returns auth code for Convex action.
 */

import * as WebBrowser from "expo-web-browser";

const SMARTCAR_CLIENT_ID = process.env.EXPO_PUBLIC_SMARTCAR_CLIENT_ID!;
const REDIRECT_URI = "otopair://smartcar/callback";

const SCOPES = [
  "read_vehicle_info",
  "read_vin",
  "read_odometer",
  "read_location",
  "read_tires",
  "read_engine_oil",
  "read_fuel",
  "read_battery",
  "read_security",
  "read_service_history",
];

export interface SmartcarOAuthResult {
  success: boolean;
  code?: string;
  error?: string;
}

/**
 * Opens Smartcar Connect flow in an in-app browser.
 * Returns the authorization code for exchangeCodeAndConnect action.
 */
export async function openSmartcarConnect(
  userId: string
): Promise<SmartcarOAuthResult> {
  try {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: SMARTCAR_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPES.join(" "),
      state: userId,
      mode : "live",
    });

    const authUrl = `https://connect.smartcar.com/oauth/authorize?${params.toString()}`;

    const result = await WebBrowser.openAuthSessionAsync(authUrl, REDIRECT_URI);

    if (result.type !== "success") {
      return {
        success: false,
        error: result.type === "cancel" ? "Cancelled" : "Failed",
      };
    }

    const url = new URL(result.url);
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    const state = url.searchParams.get("state");

    if (error) {
      return {
        success: false,
        error: url.searchParams.get("error_description") || error,
      };
    }

    if (!code) {
      return { success: false, error: "No authorization code received" };
    }

    if (state !== userId) {
      return { success: false, error: "State mismatch" };
    }

    return { success: true, code };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}