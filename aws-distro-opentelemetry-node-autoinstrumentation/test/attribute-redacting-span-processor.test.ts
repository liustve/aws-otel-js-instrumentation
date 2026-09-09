// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes } from '@opentelemetry/api';
import { BatchSpanProcessor, InMemorySpanExporter, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import expect from 'expect';
import {
  AttributeRedactingSpanProcessor,
  ENV_ADOT_REDACT_SPAN_ATTRIBUTES,
  REDACTED_VALUE,
} from '../src/attribute-redacting-span-processor';

interface RedactionTestData {
  name: string;
  environmentValue: string;
  spanAttributes: Attributes;
  eventAttributes: Attributes;
  expectedSpanAttributes: Attributes;
  expectedEventAttributes: Attributes;
}

describe('AttributeRedactingSpanProcessorTest', () => {
  it('should redact all attributes that match configured patterns', async () => {
    const testCases: RedactionTestData[] = [
      {
        name: 'configured attribute names',
        environmentValue: ' user.email, request.body, db.statement, gen_ai.prompt, user.email ',
        spanAttributes: {
          'user.email': 'user@example.com',
          'request.body': '{"password":"secret"}',
          'db.statement': 'SELECT * FROM users',
          'gen_ai.prompt': 'private prompt',
          'http.request.method': 'POST',
          'server.address': 'example.com',
        },
        eventAttributes: {
          'user.email': 'event-user@example.com',
          'db.statement': "UPDATE users SET password = 'secret'",
          'gen_ai.prompt': 'private event prompt',
          'event.safe': 'keep me',
        },
        expectedSpanAttributes: {
          'user.email': REDACTED_VALUE,
          'request.body': REDACTED_VALUE,
          'db.statement': REDACTED_VALUE,
          'gen_ai.prompt': REDACTED_VALUE,
          'http.request.method': 'POST',
          'server.address': 'example.com',
        },
        expectedEventAttributes: {
          'user.email': REDACTED_VALUE,
          'db.statement': REDACTED_VALUE,
          'gen_ai.prompt': REDACTED_VALUE,
          'event.safe': 'keep me',
        },
      },
      {
        name: 'wildcard only',
        environmentValue: '*',
        spanAttributes: { first: 'secret', second: 42, third: true },
        eventAttributes: { 'event.first': 'secret', 'event.second': 42 },
        expectedSpanAttributes: {
          first: REDACTED_VALUE,
          second: REDACTED_VALUE,
          third: REDACTED_VALUE,
        },
        expectedEventAttributes: {
          'event.first': REDACTED_VALUE,
          'event.second': REDACTED_VALUE,
        },
      },
      {
        name: 'prefix wildcard',
        environmentValue: 'http.*',
        spanAttributes: {
          'http.request.method': 'GET',
          'http.response.status_code': 200,
          'server.address': 'example.com',
        },
        eventAttributes: {
          'http.request.header.authorization': 'secret',
          'event.safe': 'keep me',
        },
        expectedSpanAttributes: {
          'http.request.method': REDACTED_VALUE,
          'http.response.status_code': REDACTED_VALUE,
          'server.address': 'example.com',
        },
        expectedEventAttributes: {
          'http.request.header.authorization': REDACTED_VALUE,
          'event.safe': 'keep me',
        },
      },
      {
        name: 'suffix wildcard',
        environmentValue: '*.body',
        spanAttributes: {
          'request.body': 'secret',
          'response.body': 'secret',
          'body.size': 42,
        },
        eventAttributes: {
          'message.body': 'secret',
          'message.body.size': 42,
        },
        expectedSpanAttributes: {
          'request.body': REDACTED_VALUE,
          'response.body': REDACTED_VALUE,
          'body.size': 42,
        },
        expectedEventAttributes: {
          'message.body': REDACTED_VALUE,
          'message.body.size': 42,
        },
      },
      {
        name: 'multiple wildcard segments',
        environmentValue: 'gen_ai.*.content',
        spanAttributes: {
          'gen_ai.input.content': 'secret input',
          'gen_ai.output.content': 'secret output',
          'gen_ai.request.model': 'model',
        },
        eventAttributes: {
          'gen_ai.tool.content': 'secret event',
          'gen_ai.tool.name': 'lookup',
        },
        expectedSpanAttributes: {
          'gen_ai.input.content': REDACTED_VALUE,
          'gen_ai.output.content': REDACTED_VALUE,
          'gen_ai.request.model': 'model',
        },
        expectedEventAttributes: {
          'gen_ai.tool.content': REDACTED_VALUE,
          'gen_ai.tool.name': 'lookup',
        },
      },
      {
        name: 'wildcard mixed with explicit names',
        environmentValue: 'user.email,http.*',
        spanAttributes: {
          'user.email': 'user@example.com',
          'http.route': '/users',
          safe: 'value',
        },
        eventAttributes: {
          'user.email': 'event-user@example.com',
          'http.response.body': 'secret',
          'event.safe': 'keep me',
        },
        expectedSpanAttributes: {
          'user.email': REDACTED_VALUE,
          'http.route': REDACTED_VALUE,
          safe: 'value',
        },
        expectedEventAttributes: {
          'user.email': REDACTED_VALUE,
          'http.response.body': REDACTED_VALUE,
          'event.safe': 'keep me',
        },
      },
    ];

    for (let index = 0; index < testCases.length; index += 1) {
      await assertRedaction(testCases[index]);
    }
  });

  it('should not redact attributes for invalid configured patterns', async () => {
    const testCases: RedactionTestData[] = [
      {
        name: 'empty configuration',
        environmentValue: '',
        spanAttributes: { 'user.email': 'user@example.com' },
        eventAttributes: { 'user.email': 'event-user@example.com' },
        expectedSpanAttributes: { 'user.email': 'user@example.com' },
        expectedEventAttributes: { 'user.email': 'event-user@example.com' },
      },
      {
        name: 'empty comma-separated entries',
        environmentValue: ' , , ',
        spanAttributes: { 'request.body': 'secret' },
        eventAttributes: { 'request.body': 'event secret' },
        expectedSpanAttributes: { 'request.body': 'secret' },
        expectedEventAttributes: { 'request.body': 'event secret' },
      },
      {
        name: 'whitespace-only configuration',
        environmentValue: ' \t ',
        spanAttributes: { 'db.statement': 'SELECT * FROM users' },
        eventAttributes: { 'db.statement': 'DELETE FROM users' },
        expectedSpanAttributes: { 'db.statement': 'SELECT * FROM users' },
        expectedEventAttributes: { 'db.statement': 'DELETE FROM users' },
      },
      {
        name: 'unsupported regular expression',
        environmentValue: 'http\\.request\\..+',
        spanAttributes: { 'http.request.method': 'POST' },
        eventAttributes: { 'http.request.body': 'secret' },
        expectedSpanAttributes: { 'http.request.method': 'POST' },
        expectedEventAttributes: { 'http.request.body': 'secret' },
      },
      {
        name: 'unsupported regular expression anchors',
        environmentValue: '^user.email$',
        spanAttributes: { 'user.email': 'user@example.com' },
        eventAttributes: { 'user.email': 'event-user@example.com' },
        expectedSpanAttributes: { 'user.email': 'user@example.com' },
        expectedEventAttributes: { 'user.email': 'event-user@example.com' },
      },
      {
        name: 'unsupported regular expression character class',
        environmentValue: 'http.request.[a-z]+',
        spanAttributes: { 'http.request.method': 'POST' },
        eventAttributes: { 'http.request.body': 'secret' },
        expectedSpanAttributes: { 'http.request.method': 'POST' },
        expectedEventAttributes: { 'http.request.body': 'secret' },
      },
      {
        name: 'unsupported regular expression alternation',
        environmentValue: 'user.email|request.body',
        spanAttributes: {
          'user.email': 'user@example.com',
          'request.body': 'secret',
        },
        eventAttributes: {
          'user.email': 'event-user@example.com',
          'request.body': 'event secret',
        },
        expectedSpanAttributes: {
          'user.email': 'user@example.com',
          'request.body': 'secret',
        },
        expectedEventAttributes: {
          'user.email': 'event-user@example.com',
          'request.body': 'event secret',
        },
      },
      {
        name: 'unsupported question mark wildcard',
        environmentValue: 'http.request.?',
        spanAttributes: { 'http.request.method': 'POST' },
        eventAttributes: { 'http.request.body': 'secret' },
        expectedSpanAttributes: { 'http.request.method': 'POST' },
        expectedEventAttributes: { 'http.request.body': 'secret' },
      },
      {
        name: 'malformed bracket pattern',
        environmentValue: 'http.request.[',
        spanAttributes: { 'http.request.method': 'POST' },
        eventAttributes: { 'http.request.body': 'secret' },
        expectedSpanAttributes: { 'http.request.method': 'POST' },
        expectedEventAttributes: { 'http.request.body': 'secret' },
      },
      {
        name: 'attribute name containing comma',
        environmentValue: 'custom,attribute',
        spanAttributes: { 'custom,attribute': 'secret' },
        eventAttributes: { 'custom,attribute': 'event secret' },
        expectedSpanAttributes: { 'custom,attribute': 'secret' },
        expectedEventAttributes: { 'custom,attribute': 'event secret' },
      },
    ];

    for (let index = 0; index < testCases.length; index += 1) {
      await assertRedaction(testCases[index]);
    }
  });
});

async function assertRedaction(testData: RedactionTestData): Promise<void> {
  const previousEnvironmentValue = process.env[ENV_ADOT_REDACT_SPAN_ATTRIBUTES];
  const exporter = new InMemorySpanExporter();
  let provider: NodeTracerProvider | undefined;

  try {
    process.env[ENV_ADOT_REDACT_SPAN_ATTRIBUTES] = testData.environmentValue;
    provider = new NodeTracerProvider({
      spanProcessors: [new AttributeRedactingSpanProcessor(), new BatchSpanProcessor(exporter)],
    });
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test', {
      attributes: testData.spanAttributes,
    });
    span.addEvent('test.event', testData.eventAttributes);
    span.end();

    await provider.forceFlush();
    const finishedSpans = exporter.getFinishedSpans();
    expect(finishedSpans).toHaveLength(1);
    expect(finishedSpans[0].attributes).toEqual(testData.expectedSpanAttributes);
    expect(finishedSpans[0].events).toHaveLength(1);
    expect(finishedSpans[0].events[0].name).toBe('test.event');
    expect(finishedSpans[0].events[0].attributes).toEqual(testData.expectedEventAttributes);
  } finally {
    await provider?.shutdown();
    if (previousEnvironmentValue === undefined) {
      delete process.env[ENV_ADOT_REDACT_SPAN_ATTRIBUTES];
    } else {
      process.env[ENV_ADOT_REDACT_SPAN_ATTRIBUTES] = previousEnvironmentValue;
    }
  }
}
