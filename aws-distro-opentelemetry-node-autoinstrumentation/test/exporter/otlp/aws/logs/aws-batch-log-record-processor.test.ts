// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as sinon from 'sinon';
import {
  MAX_LOG_REQUEST_BYTE_SIZE,
  AwsBatchLogRecordProcessor,
  BASE_LOG_BUFFER_BYTE_SIZE,
} from '../../../../../src/exporter/otlp/aws/logs/aws-batch-log-record-processor';
import { LogRecord } from '@opentelemetry/sdk-logs';
import { AnyValue, SeverityNumber, LogRecord as apiLogRecord } from '@opentelemetry/api-logs';
import { DEFAULT_ATTRIBUTE_COUNT_LIMIT, ExportResultCode } from '@opentelemetry/core';
import { LoggerProviderSharedState } from '@opentelemetry/sdk-logs/build/src/internal/LoggerProviderSharedState';
import expect from 'expect';
import { IResource } from '@opentelemetry/resources';

describe('AwsBatchLogRecordProcessor', () => {
  let mockExporter: any;
  let processor: AwsBatchLogRecordProcessor;
  let maxLogSize: number;
  let baseLogSize: number;

  beforeEach(() => {
    mockExporter = {
      export: sinon.stub().callsFake((logs, resultCallback) => {
        resultCallback({ code: ExportResultCode.SUCCESS });
        return;
      }),
      setGenAILogFlag: sinon.stub(),
      shutdown: sinon.stub(),
    };

    processor = new AwsBatchLogRecordProcessor(mockExporter);
    maxLogSize = MAX_LOG_REQUEST_BYTE_SIZE;
    baseLogSize = BASE_LOG_BUFFER_BYTE_SIZE;
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('estimateLogSize', () => {
    it('should correctly handle nested structures (dict/array)', () => {
      const messageSize = 400;
      const message = 'X'.repeat(messageSize);
      
      const nestDictLog = generateTestLogData(1, message, 't', message, 2, 2, true)[0];
      const nestArrayLog = generateTestLogData(1, message, 't', message, 2, 2, false)[0];
      
      const expectedSize = baseLogSize + messageSize * 2;
      
      const dictSize = (processor as any).estimateLogSize(nestDictLog, 2);
      const arraySize = (processor as any).estimateLogSize(nestArrayLog, 2);
      
      expect(Math.abs(dictSize - expectedSize)).toBeLessThan(10);
      expect(Math.abs(arraySize - expectedSize)).toBeLessThan(10);
    });

    it('should cut off calculation for nested structure that exceeds depth limit', () => {
      const calculated = 'X'.repeat(400);
      const message = {
        calculated: calculated,
        truncated: { truncated: { test: 'X'.repeat(maxLogSize) } }
      };
      
      const expectedSize = baseLogSize + ('calculated'.length + calculated.length + 'truncated'.length) * 2;
      
      const nestDictLog = generateTestLogData(1, message, 't', message, 3, 3, true)[0];
      const nestArrayLog = generateTestLogData(1, message, 't', message, 3, 3, false)[0];
      
      const dictSize = (processor as any).estimateLogSize(nestDictLog, 4);
      const arraySize = (processor as any).estimateLogSize(nestArrayLog, 4);
      
      expect(Math.abs(dictSize - expectedSize)).toBeLessThan(10);
      expect(Math.abs(arraySize - expectedSize)).toBeLessThan(10);
    });

    it('should return prematurely if size exceeds max log size', () => {
      const message = {
        bigKey: 'X'.repeat(maxLogSize),
        smallKey: 'X'.repeat(maxLogSize * 10)
      };
      
      const expectedSize = baseLogSize + maxLogSize + 'bigKey'.length;
      
      const nestDictLog = generateTestLogData(1, message, '', '', -1, -1, true)[0];
      const nestArrayLog = generateTestLogData(1, message, '', '', -1, -1, false)[0];
      
      const dictSize = (processor as any).estimateLogSize(nestDictLog);
      const arraySize = (processor as any).estimateLogSize(nestArrayLog);
      
      expect(Math.abs(dictSize - expectedSize)).toBeLessThan(10);
      expect(Math.abs(arraySize - expectedSize)).toBeLessThan(10);
    });

    it('should handle primitive types correctly', () => {
      const primitives: AnyValue[] = ['test', new Uint8Array([116, 101, 115, 116]), 1, 1.2, true, false, null];
      const expectedSizes = [4, 4, 1, 3, 4, 5, 0];
      
      for (let i = 0; i < primitives.length; i++) {
        const log = generateTestLogData(1, primitives[i], '', '', -1, -1)[0];
        const expectedSize = baseLogSize + expectedSizes[i];
        const actualSize = (processor as any).estimateLogSize(log);
        
        expect(actualSize).toBe(expectedSize);
      }
    });
  });

  describe('_flushOneBatch', () => {
    it('should export single batch if under size limit', async () => {
      const logCount = 10;
      const testLogs = generateTestLogData(logCount, 'test');
      
      for (const log of testLogs) {
        processor.onEmit(log);
      }
      
      await (processor as any)._flushOneBatch();
      
      expect((processor as any)._finishedLogRecords.length).toBe(0);
      expect(mockExporter.export.callCount).toBe(1);
      
      const exportedBatch = mockExporter.export.getCalls()[0].args[0];
      expect(exportedBatch.length).toBe(logCount);
      expect(mockExporter.setGenAILogFlag.callCount).toBe(0);
    });

    it('should make multiple export calls for logs over size limit', async () => {
      const largeLogBody = 'X'.repeat(maxLogSize + 1);
      const nonGenAiLogs = generateTestLogData(3, largeLogBody);
      const genAiLogs = generateTestLogData(3, largeLogBody, '', '', -1, -1, true, 'openinference.instrumentation.langchain');
      
      const testLogs = [...genAiLogs, ...nonGenAiLogs];
      
      for (const log of testLogs) {
        processor.onEmit(log);
      }
      
      await (processor as any)._flushOneBatch();
      
      expect((processor as any)._finishedLogRecords.length).toBe(0);
      expect(mockExporter.export.callCount).toBe(6);
      expect(mockExporter.setGenAILogFlag.callCount).toBe(3);
      
      const exportCalls = mockExporter.export.getCalls();
      for (const call of exportCalls) {
        expect(call.args[0].length).toBe(1);
      }
    });

    it('should correctly batch logs of mixed sizes', async () => {
      const largeLogBody = 'X'.repeat(maxLogSize + 1);
      const smallLogBody = 'X'.repeat(Math.floor(maxLogSize / 10) - baseLogSize);
      
      const largeLogs = generateTestLogData(3, largeLogBody, '', '', -1, -1, true, 'openinference.instrumentation.langchain');
      const smallLogs = generateTestLogData(12, smallLogBody, '', '', -1, -1, true, 'openinference.instrumentation.langchain');
      
      const testLogs = [...largeLogs, ...smallLogs];
      
      for (const log of testLogs) {
        processor.onEmit(log);
      }
      
      await (processor as any)._flushOneBatch();
      
      expect((processor as any)._finishedLogRecords.length).toBe(0);
      expect(mockExporter.export.callCount).toBe(5);
      expect(mockExporter.setGenAILogFlag.callCount).toBe(3);
      
      const exportCalls = mockExporter.export.getCalls();
      const expectedSizes = [1, 1, 1, 10, 2];
      
      for (let i = 0; i < exportCalls.length; i++) {
        expect(exportCalls[i].args[0].length).toBe(expectedSizes[i]);
      }
    });
  });

  function generateNestedValue(depth: number, value: AnyValue, createMap: boolean = true): AnyValue {
    if (depth < 0) {
      return value;
    }
    
    if (createMap) {
      return { t: generateNestedValue(depth - 1, value, true) };
    }
    
    return [generateNestedValue(depth - 1, value, false)];
  }

  function generateTestLogData(
    count: number = 1,
    logBody?: AnyValue,
    attrKey: string = '',
    attrVal?: AnyValue,
    logBodyDepth: number = 3,
    attrDepth: number = 3,
    createMap: boolean = true,
    instrumentationScopeName: string = 'test-scope'
  ): LogRecord[] {
    const logs: LogRecord[] = [];

    for (let i = 0; i < count; i++) {
      const sharedState: LoggerProviderSharedState = {
        resource: {} as IResource,
        forceFlushTimeoutMillis: 10000,
        logRecordLimits: {
          attributeValueLengthLimit: DEFAULT_ATTRIBUTE_COUNT_LIMIT,
          attributeCountLimit: DEFAULT_ATTRIBUTE_COUNT_LIMIT,
        },
        loggers: new Map(),
        activeProcessor: processor,
        registeredLogRecordProcessors: [],
      };

      const body = logBody ? generateNestedValue(logBodyDepth, logBody, createMap) : `Test log message ${i}`;
      const attributes = attrKey && attrVal ? 
        { [attrKey]: generateNestedValue(attrDepth, attrVal, createMap) } : 
        { 'test.attribute': i };

      const logRecord: apiLogRecord = {
        timestamp: Date.now(),
        severityNumber: SeverityNumber.INFO,
        severityText: 'INFO',
        body: body,
        attributes: attributes,
      };

      const log = new LogRecord(sharedState, { name: instrumentationScopeName, version: '1.0.0' }, logRecord);
      logs.push(log);
    }

    return logs;
  }
});
