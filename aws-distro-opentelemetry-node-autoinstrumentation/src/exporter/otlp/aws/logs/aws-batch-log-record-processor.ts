// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { LogRecord, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { AnyValue } from '@opentelemetry/api-logs';
import { callWithTimeout } from '@opentelemetry/core';
import type { BufferConfig } from '@opentelemetry/sdk-logs';
import { OTLPAwsLogExporter } from './otlp-aws-log-exporter';
import { diag } from '@opentelemetry/api';

export const BASE_LOG_BUFFER_BYTE_SIZE: number = 1500;
export const MAX_LOG_REQUEST_BYTE_SIZE: number = 1048576;

export class AwsBatchLogRecordProcessor extends BatchLogRecordProcessor {
  constructor(exporter: OTLPAwsLogExporter, config?: BufferConfig) {
    super(exporter, config);
    (this as any)._flushOneBatch = () => this._flushOneBatchIntermediary();
  }

  /**
   * Custom implementation of BatchLogRecordProcessor that manages log record batching
   * with size-based constraints to prevent exceeding AWS request size limits.
   *
   * This processor still exports all logs up to maxExportBatchSize but rather than doing exactly
   * one export promise, we do an array of export Promises where each exported batch will have an additonal constraint:
   *
   * If the batch to be exported will have a data size of > 1 MB:
   * The batch will be split into multiple exports of sub-batches of data size <= 1 MB.
   *
   * A unique case is if the sub-batch is of data size > 1 MB, then the sub-batch will have exactly 1 log in it.
   *
   */
  private _flushOneBatchIntermediary(): Promise<void> {
    const processor = this as any;

    processor._clearTimer();

    if (processor._finishedLogRecords.length === 0) {
      return Promise.resolve();
    }

    const logsToExport: LogRecord[] = processor._finishedLogRecords.splice(0, processor._maxExportBatchSize);
    let batch: LogRecord[] = [];
    let batchDataSize = 0;
    const exportPromises: Promise<void>[] = [];

    for (let i = 0; i < logsToExport.length; i += 1) {
      const logData = logsToExport[i];
      const logSize = this.estimateLogSize(logData);

      if (batch.length > 0 && batchDataSize + logSize > MAX_LOG_REQUEST_BYTE_SIZE) {
        // if batchDataSize > MAX_LOG_REQUEST_BYTE_SIZE then batch.length == 1
        if (batchDataSize > MAX_LOG_REQUEST_BYTE_SIZE && AwsBatchLogRecordProcessor.isGenAILog(logData)) {
          (processor._exporter as OTLPAwsLogExporter).setGenAILogFlag();
        }

        exportPromises.push(callWithTimeout(processor._export(batch), processor._exportTimeoutMillis));
        batchDataSize = 0;
        batch = [];
      }

      batchDataSize += logSize;
      batch.push(logData);
    }

    if (batch.length > 0) {
      // if batchDataSize > MAX_LOG_REQUEST_BYTE_SIZE then batch.length == 1
      if (batchDataSize > MAX_LOG_REQUEST_BYTE_SIZE && AwsBatchLogRecordProcessor.isGenAILog(batch[0])) {
        (processor._exporter as OTLPAwsLogExporter).setGenAILogFlag();
      }

      exportPromises.push(callWithTimeout(processor._export(batch), processor._exportTimeoutMillis));
    }

    return new Promise((resolve, reject) => {
      Promise.all(exportPromises)
        .then(() => resolve())
        .catch(reject);
    });
  }

  /**
   * Estimates the size in bytes of a log by calculating the size of its body and its attributes
   * and adding a buffer amount to account for other log metadata information.
   * Will process complex log structures up to the specified depth limit.
   * If the depth limit of the log structure is exceeded, returns truncates calculation
   * to everything up to that point.
   * @param log - The Log object to calculate size for
   * @param depth - Maximum depth to traverse in nested structures (default: 3)
   * @returns The estimated size of the log object in bytes
   */
  private estimateLogSize(log: LogRecord, depth: number = 3): number {
    // Use a queue to prevent excessive recursive calls.
    // We calculate based on the size of the log record body and attributes for the log.
    let queue: Array<[AnyValue, number]> = [
      [log.body, 0],
      [log.attributes, -1],
    ];

    let size: number = BASE_LOG_BUFFER_BYTE_SIZE;

    while (queue.length > 0) {
      const newQueue: Array<[AnyValue, number]> = [];

      for (const data of queue) {
        // small optimization, can stop calculating the size once it reaches the 1 MB limit.
        if (size >= MAX_LOG_REQUEST_BYTE_SIZE) {
          return size;
        }

        const [nextVal, currentDepth] = data;

        if (typeof nextVal === 'string') {
          size += nextVal.length;
          continue;
        }

        if (nextVal instanceof Uint8Array) {
          size += nextVal.byteLength;
          continue;
        }

        if (typeof nextVal === 'boolean') {
          size += nextVal ? 4 : 5;
          continue;
        }

        if (typeof nextVal === 'number') {
          size += nextVal.toString().length;
          continue;
        }

        if (currentDepth <= depth) {
          if (Array.isArray(nextVal)) {
            for (const content of nextVal) {
              newQueue.push([content, currentDepth + 1]);
            }

            continue;
          }

          // By process of elimination, it has to be AnyValueMap
          for (const key in nextVal) {
            size += key.length;
            newQueue.push([nextVal[key], currentDepth + 1]);
          }
        } else {
          diag.debug('Max log depth of %s exceeded. Log data size will not be accurately calculated.', depth);
        }
      }

      queue = newQueue;
    }

    return size;
  }

  private static isGenAILog(log: LogRecord): boolean {
    const genAiInstrumentations = new Set([
      'openinference.instrumentation.langchain',
      'openinference.instrumentation.crewai',
      'opentelemetry.instrumentation.langchain',
      'crewai.telemetry',
      'openlit.otel.tracing',
    ]);

    return log.instrumentationScope.name in genAiInstrumentations;
  }
}
