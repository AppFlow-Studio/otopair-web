declare module "*.css";

export {};

declare global {
  interface CustomJwtSessionClaims {
    metadata: {
      role?: "user" | "shop_owner" | "mechanic" | "admin";
    };
  }
}
