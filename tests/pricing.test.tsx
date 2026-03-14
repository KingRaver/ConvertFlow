import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { PricingContent } from "../client/src/pages/Pricing";

function installLocation() {
  Object.assign(globalThis, {
    location: new URL("http://localhost/pricing"),
  });
}

test("PricingContent shows an explicit disabled billing state when checkout is unconfigured", () => {
  installLocation();

  const html = renderToStaticMarkup(
    <PricingContent
      activeAction={null}
      billingCapabilityState="unconfigured"
      billingState={null}
      currentPlan="free"
      error={null}
      isAuthenticated={false}
      onCheckout={() => undefined}
      onPortal={() => undefined}
      userEmail={null}
    />,
  );

  assert.match(html, /Billing unavailable on this deployment/);
  assert.match(html, /Stripe checkout and portal access stay disabled/);
  assert.match(html, /Unavailable on this deployment/);
});

test("PricingContent keeps billing actions live when checkout is configured", () => {
  installLocation();

  const html = renderToStaticMarkup(
    <PricingContent
      activeAction={null}
      billingCapabilityState="configured"
      billingState={null}
      currentPlan="pro"
      error={null}
      isAuthenticated={true}
      onCheckout={() => undefined}
      onPortal={() => undefined}
      userEmail="pricing@example.com"
    />,
  );

  assert.match(html, /Billing and limits live/);
  assert.match(html, /Manage billing/);
  assert.doesNotMatch(html, /Billing unavailable on this deployment/);
});
