// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes } from '@opentelemetry/api';
import { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

export const ENV_ADOT_REDACT_SPAN_ATTRIBUTES = 'ADOT_REDACT_SPAN_ATTRIBUTES';
export const ENV_ADOT_REDACT_SPAN_EVENT_ATTRIBUTES = 'ADOT_REDACT_SPAN_EVENT_ATTRIBUTES';
export const REDACTED_VALUE = 'REDACTED';

/**
 * Redacts separately configured attributes on completed spans and span events.
 *
 * Span and span event attribute names can be supplied to the constructor or
 * through the ADOT_REDACT_SPAN_ATTRIBUTES and
 * ADOT_REDACT_SPAN_EVENT_ATTRIBUTES environment variables as comma-separated
 * lists. Each entry can be an exact attribute name or contain * wildcards.
 * Matching attribute values are replaced with REDACTED in place while
 * attribute names and non-matching values remain unchanged.
 *
 * Redact several exact span attributes and every span attribute beginning with
 * http.request.:
 *
 * ADOT_REDACT_SPAN_ATTRIBUTES=user.email,request.body,db.statement,http.request.*
 *
 * Redact matching GenAI content attributes from span events:
 *
 * ADOT_REDACT_SPAN_EVENT_ATTRIBUTES=gen_ai.*.content
 *
 * Redact every span attribute and every span event attribute:
 *
 * ADOT_REDACT_SPAN_ATTRIBUTES=*
 * ADOT_REDACT_SPAN_EVENT_ATTRIBUTES=*
 */
export class AttributeRedactingSpanProcessor implements SpanProcessor {
  public readonly spanAttributesToRedact: string[];
  public readonly spanEventAttributesToRedact: string[];
  private readonly compiledSpanAttributePatterns: RegExp[];
  private readonly compiledSpanEventAttributePatterns: RegExp[];

  public constructor(spanAttributesToRedact?: string[], spanEventAttributesToRedact?: string[]) {
    this.spanAttributesToRedact =
      spanAttributesToRedact && spanAttributesToRedact.length > 0
        ? [...spanAttributesToRedact]
        : (process.env[ENV_ADOT_REDACT_SPAN_ATTRIBUTES] ?? '')
            .split(',')
            .map(attribute => attribute.trim())
            .filter(attribute => attribute.length > 0);
    this.spanEventAttributesToRedact =
      spanEventAttributesToRedact && spanEventAttributesToRedact.length > 0
        ? [...spanEventAttributesToRedact]
        : (process.env[ENV_ADOT_REDACT_SPAN_EVENT_ATTRIBUTES] ?? '')
            .split(',')
            .map(attribute => attribute.trim())
            .filter(attribute => attribute.length > 0);
    this.compiledSpanAttributePatterns = this.spanAttributesToRedact.map(attribute => {
      const pattern = attribute.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      return new RegExp(`^${pattern}$`);
    });
    this.compiledSpanEventAttributePatterns = this.spanEventAttributesToRedact.map(attribute => {
      const pattern = attribute.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      return new RegExp(`^${pattern}$`);
    });
  }

  public onStart(): void {}

  public onEnd(span: ReadableSpan): void {
    if (this.spanAttributesToRedact.length === 0 && this.spanEventAttributesToRedact.length === 0) {
      return;
    }

    if (this.spanAttributesToRedact.length > 0) {
      this.redactAttributes(span.attributes, this.compiledSpanAttributePatterns);
    }

    if (this.spanEventAttributesToRedact.length > 0) {
      span.events.forEach(event => this.redactAttributes(event.attributes, this.compiledSpanEventAttributePatterns));
    }
  }

  private redactAttributes(attributes: Attributes | undefined, compiledPatterns: RegExp[]): void {
    if (!attributes) {
      return;
    }

    Object.keys(attributes).forEach(attributeName => {
      if (this.shouldRedact(attributeName, compiledPatterns)) {
        attributes[attributeName] = REDACTED_VALUE;
      }
    });
  }

  private shouldRedact(attributeName: string, compiledPatterns: RegExp[]): boolean {
    return compiledPatterns.some(pattern => pattern.test(attributeName));
  }

  public shutdown(): Promise<void> {
    return Promise.resolve();
  }

  public forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
