declare module "*.css";
declare module "react-big-calendar/lib/css/react-big-calendar.css";
declare module "./schedule.css";

export {};

declare global {
  interface CustomJwtSessionClaims {
    metadata: {
      role?: "user" | "shop_owner" | "mechanic" | "admin";
    };
  }
}
