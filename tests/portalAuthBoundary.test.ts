import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PortalAuthBoundary } from "../components/portal/portal-auth-boundary";

const protectedContent = createElement("div", null, "Protected portal content");

describe("PortalAuthBoundary", () => {
  test("unmounts protected portal content as soon as Clerk reports signed out", () => {
    const html = renderToStaticMarkup(
      createElement(
        PortalAuthBoundary,
        { isLoaded: true, isSignedIn: false, allowSignedOut: false },
        protectedContent,
      ),
    );

    expect(html).toContain("Please wait, signing you out.");
    expect(html).not.toContain("Protected portal content");
  });

  test("shows the signing-out screen before Clerk reports the session closed", () => {
    const html = renderToStaticMarkup(
      createElement(
        PortalAuthBoundary,
        {
          isLoaded: true,
          isSignedIn: true,
          isSigningOut: true,
          allowSignedOut: false,
        },
        protectedContent,
      ),
    );

    expect(html).toContain("Please wait, signing you out.");
    expect(html).toContain("animate-spin");
    expect(html).not.toContain("Protected portal content");
  });

  test("renders protected portal content while signed in", () => {
    const html = renderToStaticMarkup(
      createElement(
        PortalAuthBoundary,
        { isLoaded: true, isSignedIn: true, allowSignedOut: false },
        protectedContent,
      ),
    );

    expect(html).toContain("Protected portal content");
  });

  test("keeps the public invite flow mounted while signed out", () => {
    const html = renderToStaticMarkup(
      createElement(
        PortalAuthBoundary,
        { isLoaded: true, isSignedIn: false, allowSignedOut: true },
        protectedContent,
      ),
    );

    expect(html).toContain("Protected portal content");
  });
});
