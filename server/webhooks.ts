import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Conversion, Webhook, WebhookEventType } from "@shared/schema";
import { storage } from "./storage";

const WEBHOOK_REQUEST_TIMEOUT_MS = 10_000;
const WEBHOOK_SECRET_BYTES = 32;

export const WEBHOOK_DELIVERY_RETRY_DELAYS_MS = [500, 2_000, 10_000] as const;
export const WEBHOOK_DELIVERY_ID_HEADER = "x-convertflow-delivery-id";
export const WEBHOOK_EVENT_HEADER = "x-convertflow-event";
export const WEBHOOK_SIGNATURE_HEADER = "x-convertflow-signature";
export const WEBHOOK_TIMESTAMP_HEADER = "x-convertflow-timestamp";

export interface WebhookDeliveryPayload {
  attempt: number;
  conversionId: number;
  event: WebhookEventType;
  webhookId: number;
}

export interface WebhookDeliveryResult {
  delivered: boolean;
  retryAt?: Date;
}

export function createWebhookSecret() {
  return randomBytes(WEBHOOK_SECRET_BYTES).toString("hex");
}

export function serializeWebhook(webhook: Webhook) {
  return {
    id: webhook.id,
    url: webhook.url,
    events: webhook.events,
    createdAt: webhook.createdAt?.toISOString() ?? null,
  };
}

function serializeConversionForWebhook(conversion: Conversion) {
  return {
    id: conversion.id,
    originalName: conversion.originalName,
    originalFormat: conversion.originalFormat,
    targetFormat: conversion.targetFormat,
    status: conversion.status,
    fileSize: conversion.fileSize,
    convertedSize: conversion.convertedSize,
    outputFilename: conversion.outputFilename,
    resultMessage: conversion.resultMessage,
    engineUsed: conversion.engineUsed,
    expiresAt: conversion.expiresAt?.toISOString() ?? null,
    createdAt: conversion.createdAt?.toISOString() ?? null,
    processingStartedAt: conversion.processingStartedAt?.toISOString() ?? null,
  };
}

function createWebhookSignature(secret: string, timestamp: string, body: string) {
  const digest = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");

  return `sha256=${digest}`;
}

function getRetryAt(attempt: number, now = new Date()) {
  const delayMs = WEBHOOK_DELIVERY_RETRY_DELAYS_MS[attempt];
  if (delayMs === undefined) {
    return undefined;
  }

  return new Date(now.getTime() + delayMs);
}

export async function processWebhookDelivery(
  payload: WebhookDeliveryPayload,
): Promise<WebhookDeliveryResult> {
  const webhook = await storage.getWebhook(payload.webhookId);
  if (!webhook || !webhook.events.includes(payload.event)) {
    return { delivered: false };
  }

  const conversion = await storage.getConversion(payload.conversionId);
  if (!conversion) {
    return { delivered: false };
  }

  const body = JSON.stringify({
    event: payload.event,
    job: serializeConversionForWebhook(conversion),
  });
  const deliveryId = randomUUID();
  const timestamp = new Date().toISOString();
  const signature = createWebhookSignature(webhook.secret, timestamp, body);

  try {
    const response = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WEBHOOK_DELIVERY_ID_HEADER]: deliveryId,
        [WEBHOOK_EVENT_HEADER]: payload.event,
        [WEBHOOK_SIGNATURE_HEADER]: signature,
        [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
      },
      body,
      signal: AbortSignal.timeout(WEBHOOK_REQUEST_TIMEOUT_MS),
    });

    if (response.ok) {
      return { delivered: true };
    }

    // 4xx responses indicate a permanent client-side failure; do not retry.
    if (response.status >= 400 && response.status < 500) {
      return { delivered: false };
    }
  } catch {
    // Retry below on transport/network failures.
  }

  return {
    delivered: false,
    retryAt: getRetryAt(payload.attempt),
  };
}
